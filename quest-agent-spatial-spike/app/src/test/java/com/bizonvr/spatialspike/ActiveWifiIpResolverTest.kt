package com.bizonvr.spatialspike

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class ActiveWifiIpResolverTest {
    @Test
    fun selectsOnlyAUsableIpv4Address() {
        assertEquals("192.168.1.42", selectActiveWifiIpv4(listOf("127.0.0.1", "169.254.1.2", "192.168.1.42")))
    }

    @Test
    fun returnsNullWhenActiveWifiHasNoUsableIpv4() {
        assertNull(selectActiveWifiIpv4(listOf("127.0.0.1", "0.0.0.0", "bad-address")))
    }
}
