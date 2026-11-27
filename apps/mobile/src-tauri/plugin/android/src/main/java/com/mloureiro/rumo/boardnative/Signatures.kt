package com.mloureiro.rumo.boardnative

object Signatures {
    fun derToRaw(der: ByteArray): ByteArray {
        require(der.size > 8 && der[0] == 0x30.toByte()) { "not a DER signature" }
        var offset = 2
        if (der[1].toInt() and 0x80 != 0) offset += der[1].toInt() and 0x7f
        val r = readInteger(der, offset)
        val s = readInteger(der, offset + 2 + (der[offset + 1].toInt() and 0xff))
        return pad(r) + pad(s)
    }

    private fun readInteger(der: ByteArray, at: Int): ByteArray {
        require(der[at] == 0x02.toByte()) { "not a DER integer" }
        val length = der[at + 1].toInt() and 0xff
        return der.copyOfRange(at + 2, at + 2 + length)
    }

    private fun pad(value: ByteArray): ByteArray {
        var start = 0
        while (start < value.size - 1 && value[start] == 0.toByte()) start++
        val trimmed = value.copyOfRange(start, value.size)
        require(trimmed.size <= 32) { "integer too long" }
        return ByteArray(32 - trimmed.size) + trimmed
    }
}
