import fs from 'node:fs';
import path from 'node:path';
import { loadJson } from '../storage.js';

const PACKAGE_NAME_REGEX = /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/;

export function isValidPackage(pkg) {
    return Boolean(pkg && PACKAGE_NAME_REGEX.test(pkg));
}

export function createAppDiscovery({ config, runAdbCapture, log = () => {} } = {}) {
    const cache = {};
    const iconCacheIndex = loadJson(config.ICON_CACHE_INDEX_PATH, {});

    function formatAppName(pkg) {
        const knownNames = {
            'com.bigscreenvr.bigscreen': 'Bigscreen',
            'com.google.android.apps.youtube.vr.oculus': 'YouTube VR',
            'com.activ8.kizunaaivr': 'Kizuna AI VR',
            'com.meta.handseducationmodule': 'Hands Education Module',
            'com.bizonvr.spatialspike': 'Quest Agent spatial',
        };
        if (knownNames[pkg]) return knownNames[pkg];
        const base = pkg.split('.').pop() || pkg;
        return base.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\b\w/g, (char) => char.toUpperCase());
    }

    function parsePackages(output) {
        return output.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => line.replace(/^package:/, '')).filter(Boolean);
    }

    function parseActivityComponents(output) {
        return output.split('\n').map((line) => line.trim()).filter((line) => line && !line.includes('activities found:') && line.includes('/'));
    }

    function scoreLaunchComponent(component) {
        const normalized = component.toLowerCase();
        let score = 0;
        if (normalized.includes('internal')) score -= 50;
        if (normalized.includes('panel')) score -= 15;
        if (normalized.includes('launcher')) score += 20;
        if (normalized.includes('mainactivity')) score += 15;
        if (normalized.includes('unityplayeractivity')) score += 12;
        if (normalized.endsWith('/.mainactivity')) score += 10;
        if (normalized.includes('youtubevractivity')) score += 8;
        if (normalized.includes('vr')) score += 4;
        return score;
    }

    function chooseBestLaunchComponent(components) {
        if (!Array.isArray(components) || components.length === 0) return null;
        return [...components].sort((a, b) => scoreLaunchComponent(b) - scoreLaunchComponent(a))[0] || null;
    }

    function ensureAppIcon(pkg) {
        if (!isValidPackage(pkg)) return null;
        try {
            const cached = iconCacheIndex[pkg];
            if (cached?.fileName) {
                const iconPath = path.join(config.ICON_PUBLIC_ROOT, cached.fileName);
                if (fs.existsSync(iconPath)) return `/app-icons/${cached.fileName}`;
            }
            return null;
        } catch (error) {
            log('WARN', `Icon extraction failed for ${pkg}`, { error: error.message });
            return null;
        }
    }

    function shouldIncludeLaunchableApp(app) {
        if (config.EXCLUDED_APP_PACKAGES.has(app.package)) return false;
        if (config.INCLUDED_NON_VR_PACKAGES.has(app.package)) return true;
        if (config.EXCLUDED_APP_PREFIXES.some((prefix) => app.package.startsWith(prefix))) return false;
        if (app.sources.has('vr')) return true;
        if (app.sources.has('package')) return true;
        return app.activity.includes('com.unity3d.player.UnityPlayerActivity');
    }

    async function resolveLaunchComponentDirect(deviceSerial, packageName) {
        if (!packageName) return null;
        const queries = [
            ['-s', deviceSerial, 'shell', 'cmd', 'package', 'resolve-activity', '--brief', '-a', 'android.intent.action.MAIN', '-c', 'com.oculus.intent.category.VR', packageName],
            ['-s', deviceSerial, 'shell', 'cmd', 'package', 'resolve-activity', '--brief', '-a', 'android.intent.action.MAIN', '-c', 'android.intent.category.INFO', packageName],
            ['-s', deviceSerial, 'shell', 'cmd', 'package', 'resolve-activity', '--brief', '-a', 'android.intent.action.MAIN', '-c', 'android.intent.category.LAUNCHER', packageName],
            ['-s', deviceSerial, 'shell', 'cmd', 'package', 'resolve-activity', '--brief', '-a', 'android.intent.action.MAIN', packageName],
        ];
        for (const args of queries) {
            try {
                const output = (await runAdbCapture(args)).trim();
                const selected = chooseBestLaunchComponent(output.split('\n').map((line) => line.trim()).filter((line) => line.includes('/')));
                if (selected) return selected;
            } catch {}
        }
        return null;
    }

    async function getLaunchableApps(serial) {
        const cached = cache[serial];
        if (cached && (Date.now() - cached.timestamp) < config.APP_DISCOVERY_CACHE_MS) return cached.apps;
        try {
            const thirdPartyPackages = new Set(parsePackages(await runAdbCapture(['-s', serial, 'shell', 'cmd', 'package', 'list', 'packages', '-3'])));
            const activityQueries = [
                { source: 'launcher', args: ['-s', serial, 'shell', 'cmd', 'package', 'query-activities', '-a', 'android.intent.action.MAIN', '-c', 'android.intent.category.LAUNCHER', '--brief'] },
                { source: 'info', args: ['-s', serial, 'shell', 'cmd', 'package', 'query-activities', '-a', 'android.intent.action.MAIN', '-c', 'android.intent.category.INFO', '--brief'] },
                { source: 'vr', args: ['-s', serial, 'shell', 'cmd', 'package', 'query-activities', '-a', 'android.intent.action.MAIN', '-c', 'com.oculus.intent.category.VR', '--brief'] },
            ];
            const launchableApps = new Map();
            for (const query of activityQueries) {
                const output = await runAdbCapture(query.args);
                for (const component of parseActivityComponents(output)) {
                    const pkg = component.split('/')[0];
                    if (!thirdPartyPackages.has(pkg) || config.AGENT_PACKAGES.has(pkg)) continue;
                    const existing = launchableApps.get(pkg);
                    if (existing) {
                        existing.sources.add(query.source);
                        existing.activities.push(component);
                        existing.activity = chooseBestLaunchComponent(existing.activities) || existing.activity;
                    } else {
                        launchableApps.set(pkg, { package: pkg, name: formatAppName(pkg), activity: component, activities: [component], sources: new Set([query.source]) });
                    }
                }
            }
            for (const pkg of thirdPartyPackages) {
                if (config.AGENT_PACKAGES.has(pkg) || launchableApps.has(pkg)) continue;
                const component = await resolveLaunchComponentDirect(serial, pkg);
                if (component) launchableApps.set(pkg, { package: pkg, name: formatAppName(pkg), activity: component, activities: [component], sources: new Set(['package']) });
            }
            const apps = [...launchableApps.values()]
                .filter(shouldIncludeLaunchableApp)
                .map(({ sources, activities, ...app }) => ({ ...app, icon_url: ensureAppIcon(app.package) }))
                .sort((a, b) => a.name.localeCompare(b.name));
            cache[serial] = { apps, timestamp: Date.now() };
            return apps;
        } catch (error) {
            log('WARN', `App discovery failed for ${serial}`, { error: error.message });
            return cached?.apps || [];
        }
    }

    return Object.freeze({ getLaunchableApps, resolveLaunchComponentDirect, async resolveLaunchComponent(serial, packageName) {
        if (!packageName) return null;
        try {
            const matched = (await getLaunchableApps(serial)).find((app) => app.package === packageName && app.activity);
            if (matched?.activity) return matched.activity;
        } catch {}
        return resolveLaunchComponentDirect(serial, packageName);
    } });
}
