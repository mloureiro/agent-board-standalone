package com.mloureiro.rumo.boardnative

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

class Keystore(context: Context) {
    private val store = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
    private val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun tokenGet(serverId: String): String? {
        val stored = prefs.getString(tokenKey(serverId), null) ?: return null
        val bytes = Base64.decode(stored, Base64.NO_WRAP)
        val cipher = Cipher.getInstance(AES_MODE)
        cipher.init(Cipher.DECRYPT_MODE, wrapKey(), GCMParameterSpec(128, bytes.copyOfRange(0, IV_BYTES)))
        return String(cipher.doFinal(bytes, IV_BYTES, bytes.size - IV_BYTES), Charsets.UTF_8)
    }

    fun tokenSet(serverId: String, token: String) {
        val cipher = Cipher.getInstance(AES_MODE)
        cipher.init(Cipher.ENCRYPT_MODE, wrapKey())
        val sealed = cipher.iv + cipher.doFinal(token.toByteArray(Charsets.UTF_8))
        prefs.edit().putString(tokenKey(serverId), Base64.encodeToString(sealed, Base64.NO_WRAP)).apply()
    }

    fun tokenDelete(serverId: String) {
        prefs.edit().remove(tokenKey(serverId)).apply()
    }

    fun publicKey(serverId: String): String {
        ensureSigningKey(serverId)
        return base64Url(store.getCertificate(signAlias(serverId)).publicKey.encoded)
    }

    fun sign(serverId: String, message: ByteArray): String {
        ensureSigningKey(serverId)
        val signature = Signature.getInstance("SHA256withECDSA")
        signature.initSign(store.getKey(signAlias(serverId), null) as PrivateKey)
        signature.update(message)
        return base64Url(Signatures.derToRaw(signature.sign()))
    }

    fun deleteKey(serverId: String) {
        if (store.containsAlias(signAlias(serverId))) store.deleteEntry(signAlias(serverId))
    }

    @Synchronized
    private fun ensureSigningKey(serverId: String) {
        if (store.containsAlias(signAlias(serverId))) return
        val generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, ANDROID_KEYSTORE)
        generator.initialize(
            KeyGenParameterSpec.Builder(signAlias(serverId), KeyProperties.PURPOSE_SIGN or KeyProperties.PURPOSE_VERIFY)
                .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
                .setDigests(KeyProperties.DIGEST_SHA256)
                .build(),
        )
        generator.generateKeyPair()
    }

    @Synchronized
    private fun wrapKey(): SecretKey {
        (store.getKey(WRAP_ALIAS, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
        generator.init(
            KeyGenParameterSpec.Builder(WRAP_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return generator.generateKey()
    }

    private fun signAlias(serverId: String) = "ab-sign-$serverId"

    private fun tokenKey(serverId: String) = "token-$serverId"

    private fun base64Url(bytes: ByteArray): String =
        Base64.encodeToString(bytes, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)

    private companion object {
        const val ANDROID_KEYSTORE = "AndroidKeyStore"
        const val PREFS = "rumo-credentials"
        const val WRAP_ALIAS = "ab-token-wrap"
        const val AES_MODE = "AES/GCM/NoPadding"
        const val IV_BYTES = 12
    }
}
