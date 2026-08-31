package com.bizonvr.spatialspike

private val IPV4_PATTERN = Regex("^(?:\\d{1,3}\\.){3}\\d{1,3}$")

fun selectActiveWifiIpv4(addresses: List<String>): String? {
    return addresses.firstOrNull { value ->
        val parts = value.split('.')
        IPV4_PATTERN.matches(value) && parts.all { it.toIntOrNull()?.let { octet -> octet in 0..255 } == true } &&
            !value.startsWith("127.") && value != "0.0.0.0" && !value.startsWith("169.254.")
    }
}
