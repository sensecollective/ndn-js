/**
 * Copyright (C) 2014-2015 Regents of the University of California.
 * @author: Jeff Thompson <jefft0@remap.ucla.edu>
 * From ndn-cxx security by Yingdi Yu <yingdi@cs.ucla.edu>.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Lesser General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Lesser General Public License for more details.
 *
 * You should have received a copy of the GNU Lesser General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 * A copy of the GNU Lesser General Public License is in the file COPYING.
 */

var Blob = require('../../util/blob.js').Blob;
var SecurityException = require('../security-exception.js').SecurityException;
var PublicKey = require('../certificate/public-key.js').PublicKey;
var KeyClass = require('../security-types.js').KeyClass;
var DigestAlgorithm = require('../security-types.js').DigestAlgorithm;
var DataUtils = require('../../encoding/data-utils.js').DataUtils;
var PrivateKeyStorage = require('./private-key-storage.js').PrivateKeyStorage;
var DerNode = require('../../encoding/der/der-node').DerNode;
var OID = require('../../encoding/oid').OID;
var UseSubtleCrypto = require('../../use-subtle-crypto-node.js').UseSubtleCrypto;


/**
 * MemoryPrivateKeyStorage class extends PrivateKeyStorage to implement private
 * key storage in memory.
 * @constructor
 */
var MemoryPrivateKeyStorage = function MemoryPrivateKeyStorage()
{
  // Call the base constructor.
  PrivateKeyStorage.call(this);

  // The key is the keyName.toUri(). The value is security.certificate.PublicKey.
  this.publicKeyStore = {};
  // The key is the keyName.toUri(). The value is the object
  //  {keyType,     // number from KeyType
  //   privateKey   // The PEM-encoded private key.
  //  }.
  this.privateKeyStore = {};
};

MemoryPrivateKeyStorage.prototype = new PrivateKeyStorage();
MemoryPrivateKeyStorage.prototype.name = "MemoryPrivateKeyStorage";

exports.MemoryPrivateKeyStorage = MemoryPrivateKeyStorage;

/**
 * Set the public key for the keyName.
 * @param {Name} keyName The key name.
 * @param {number} keyType The KeyType, such as KeyType.RSA.
 * @param {Buffer} publicKeyDer The public key DER byte array.
 */
MemoryPrivateKeyStorage.prototype.setPublicKeyForKeyName = function
  (keyName, keyType, publicKeyDer)
{
  this.publicKeyStore[keyName.toUri()] = new PublicKey
    (new Blob(publicKeyDer, true));
};

/**
 * Set the private key for the keyName.
 * @param {Name} keyName The key name.
 * @param {number} keyType The KeyType, such as KeyType.RSA.
 * @param {Buffer} privateKeyDer The private key DER byte array.
 */
MemoryPrivateKeyStorage.prototype.setPrivateKeyForKeyName = function
  (keyName, keyType, privateKeyDer)
{
  // Encode the DER as PEM.
  var keyBase64 = privateKeyDer.toString('base64');
  var keyPem = "-----BEGIN RSA PRIVATE KEY-----\n";
  for (var i = 0; i < keyBase64.length; i += 64)
    keyPem += (keyBase64.substr(i, 64) + "\n");
  keyPem += "-----END RSA PRIVATE KEY-----";

  this.privateKeyStore[keyName.toUri()] =
    { keyType: keyType, privateKey: keyPem };
};

/**
 * Set the public and private key for the keyName.
 * @param {Name} keyName The key name.
 * @param {number} keyType The KeyType, such as KeyType.RSA.
 * @param {Buffer} publicKeyDer The public key DER byte array.
 * @param {Buffer} privateKeyDer The private key DER byte array.
 */
MemoryPrivateKeyStorage.prototype.setKeyPairForKeyName = function
  (keyName, keyType, publicKeyDer, privateKeyDer)
{
  this.setPublicKeyForKeyName(keyName, keyType, publicKeyDer);
  this.setPrivateKeyForKeyName(keyName, keyType, privateKeyDer);
};

/**
 * Delete a pair of asymmetric keys. If the key doesn't exist, do nothing.
 * @param {Name} keyName The name of the key pair.
 */
MemoryPrivateKeyStorage.prototype.deleteKeyPair = function(keyName)
{
  var keyUri = keyName.toUri();

  delete this.publicKeyStore[keyUri];
  delete this.privateKeyStore[keyUri];
};

/**
 * Get the public key
 * @param {Name} keyName The name of public key.
 * @returns {PublicKey} The public key.
 */
MemoryPrivateKeyStorage.prototype.getPublicKey = function(keyName)
{
  var keyUri = keyName.toUri();
  var publicKey = this.publicKeyStore[keyUri];
  if (publicKey === undefined)
    throw new SecurityException(new Error
      ("MemoryPrivateKeyStorage: Cannot find public key " + keyName.toUri()));

  return publicKey;
};

/**
 * Encode the private key to a PKCS #8 private key. We do this explicitly here
 * to avoid linking to extra OpenSSL libraries.
 * @param {Buffer} privateKeyDer The input private key DER.
 * @param {OID} oid The OID of the privateKey.
 * @param {DerNode} parameters The DerNode of the parameters for the OID.
 * @return {Blob} The PKCS #8 private key DER.
 */
MemoryPrivateKeyStorage.encodePkcs8PrivateKey = function
  (privateKeyDer, oid, parameters)
{
  var algorithmIdentifier = new DerNode.DerSequence();
  algorithmIdentifier.addChild(new DerNode.DerOid(oid));
  algorithmIdentifier.addChild(parameters);

  var result = new DerNode.DerSequence();
  result.addChild(new DerNode.DerInteger(0));
  result.addChild(algorithmIdentifier);
  result.addChild(new DerNode.DerOctetString(privateKeyDer));

  return result.encode();
};


MemoryPrivateKeyStorage.RSA_ENCRYPTION_OID = "1.2.840.113549.1.1.1";

/**
 * Fetch the private key for keyName and sign the data to produce a signature Blob.
 * @param {Buffer} data Pointer to the input byte array.
 * @param {Name} keyName The name of the signing key.
 * @param {number} digestAlgorithm (optional) The digest algorithm from
 * DigestAlgorithm, such as DigestAlgorithm.SHA256. If omitted, use
 * DigestAlgorithm.SHA256.
 * @param {function} onComplete (optional) This calls onComplete(signature) with
 * the signature Blob. If omitted, the return value is the signature Blob. (Some
 * crypto libraries only use a callback, so onComplete is required to use these.)
 * @returns {Blob} If onComplete is omitted, return the signature Blob. Otherwise,
 * return null and use onComplete as described above.
 */
MemoryPrivateKeyStorage.prototype.sign = function
  (data, keyName, digestAlgorithm, onComplete)
{
  onComplete = (typeof digestAlgorithm === "function") ? digestAlgorithm : onComplete;
  digestAlgorithm = (typeof digestAlgorithm === "function" || !digestAlgorithm) ? DigestAlgorithm.SHA256 : digestAlgorithm;

  if (digestAlgorithm != DigestAlgorithm.SHA256)
    throw new SecurityException(new Error
      ("MemoryPrivateKeyStorage.sign: Unsupported digest algorithm"));

  // Find the private key.
  var keyUri = keyName.toUri();
  var privateKey = this.privateKeyStore[keyUri];
  if (privateKey === undefined)
    throw new SecurityException(new Error
      ("MemoryPrivateKeyStorage: Cannot find private key " + keyUri));

  if (UseSubtleCrypto() && onComplete){
    var algo = {name:"RSASSA-PKCS1-v1_5",hash:{name:"SHA-256"}};

    if (!privateKey.subtleKey){
      //this is the first time in the session that we're using crypto subtle with this key
      //so we have to convert to pkcs8 and import it.
      //assigning it to privateKey.subtleKey means we only have to do this once per session,
      //giving us a small, but not insignificant, performance boost.
      var privateDER = DataUtils.privateKeyPemToDer(privateKey.privateKey);
      var pkcs8 = MemoryPrivateKeyStorage.encodePkcs8PrivateKey
        (privateDER, new OID(MemoryPrivateKeyStorage.RSA_ENCRYPTION_OID),
         new DerNode.DerNull()).buf();

      var promise = crypto.subtle.importKey("pkcs8", pkcs8.buffer, algo, true, ["sign"]).then(function(subtleKey){
        //cache the crypto.subtle key object
        privateKey.subtleKey = subtleKey;
        return crypto.subtle.sign(algo, subtleKey, data);
      });
    } else {
      //crypto.subtle key has been cached on a previous sign
      var promise = crypto.subtle.sign(algo, privateKey.subtleKey, data);
    }

    promise.then(function(signature){
      var result = new Blob(new Uint8Array(signature), true);
      onComplete(result)
    });

    return null;
  } else {
    var rsa = require("crypto").createSign('RSA-SHA256');
    rsa.update(data);

    var signature = new Buffer
      (DataUtils.toNumbersIfString(rsa.sign(privateKey.privateKey)));
    var result = new Blob(signature, false);

    if (onComplete) {
      onComplete(result);
      return null;
    }
    else
      return result;
  }

};

/**
 * Check if a particular key exists.
 * @param {Name} keyName The name of the key.
 * @param {number} keyClass The class of the key, e.g. KeyClass.PUBLIC,
 * KeyClass.PRIVATE, or KeyClass.SYMMETRIC.
 * @returns {boolean} True if the key exists, otherwise false.
 */
MemoryPrivateKeyStorage.prototype.doesKeyExist = function(keyName, keyClass)
{
  var keyUri = keyName.toUri();
  if (keyClass == KeyClass.PUBLIC)
    return this.publicKeyStore[keyUri] !== undefined;
  else if (keyClass == KeyClass.PRIVATE)
    return this.privateKeyStore[keyUri] !== undefined;
  else
    // KeyClass.SYMMETRIC not implemented yet.
    return false ;
};
