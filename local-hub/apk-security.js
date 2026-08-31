import fs from 'node:fs';
import path from 'node:path';

export function resolveApprovedApk(payload, { root, sha256File }) {
    if (payload?.apkPath || payload?.apk_path) return { error: 'APK filesystem paths are not accepted; use artifact_id' };
    const artifactId = typeof payload?.artifact_id === 'string' ? payload.artifact_id.trim() : '';
    if (!artifactId || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(artifactId)) return { error: 'A valid APK artifact_id is required' };
    const approvedRoot = path.resolve(root);
    const candidate = path.resolve(approvedRoot, artifactId.endsWith('.apk') ? artifactId : `${artifactId}.apk`);
    let realApprovedRoot;
    try {
        realApprovedRoot = fs.realpathSync(approvedRoot);
    } catch {
        return { error: 'The approved Local Hub APK cache is unavailable' };
    }
    const rootPrefix = realApprovedRoot + path.sep;
    if (!candidate.startsWith(approvedRoot + path.sep)) return { error: 'APK artifact path escapes approved cache' };
    try {
        const stat = fs.lstatSync(candidate);
        if (!stat.isFile() || stat.isSymbolicLink()) return { error: 'APK artifact must be a regular file' };
        if (!fs.realpathSync(candidate).startsWith(rootPrefix)) return { error: 'APK artifact symlink escapes approved cache' };
    } catch (error) {
        return { error: 'APK artifact was not found in the approved Local Hub cache' };
    }
    const expected = String(payload?.apk_checksum || '').toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(expected)) return { error: 'A SHA-256 APK checksum is required' };
    if (sha256File(candidate) !== expected) return { error: 'APK checksum mismatch', errorCode: 'APK_CHECKSUM_MISMATCH' };
    return { path: candidate };
}
