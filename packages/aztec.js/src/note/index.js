const bn128 = require('@aztec/bn128');
const secp256k1 = require('@aztec/secp256k1');
const BN = require('bn.js');
const { padLeft, toHex } = require('web3-utils');

const { noteCoder } = require('../encoder');
const setup = require('../setup');
const noteUtils = require('./utils');

const { createSharedSecret, getSharedSecret, getNoteHash } = noteUtils;

/**
 * @class
 * @classdesc Class for AZTEC zero-knowledge notes. Notes have public keys and viewing keys.
 *   The viewing key is required to use note in an AZTEC zero-knowledge proof
 */
class Note {
    /**
     * Initializes a new instance of Note from either a public key or a viewing key.
     *
     * @param {string} publicKey hex-formatted public key
     * @param {string} viewingKey hex-formatted viewing key
     * @param {string} owner Ethereum address of note owner
     * @param {Object} setupPoint trusted setup point
     */
    constructor(publicKey, viewingKey, owner = '0x', setupPoint) {
        if (publicKey && viewingKey) {
            throw new Error('expected one of publicKey or viewingKey, not both');
        }
        /**
         * Ethereum address of note's owner
         * @member {string}
         */
        this.owner = owner;
        if (publicKey) {
            if (typeof publicKey !== 'string') {
                throw new Error(`expected key type ${typeof publicKey} to be of type string`);
            }
            if (publicKey.length !== 200) {
                throw new Error(`invalid public key length, expected 200, got ${publicKey.length}`);
            }
            /**
             * Viewing key of note. BN instance in bn128 group's reduction context
             * @member {BN}
             */
            this.a = null;
            /**
             * Value of note. BN instance in bn128 group's reduction context
             * @member {BN}
             */
            this.k = null;
            /**
             * AZTEC commitment point \gamma, a bn128 group element, encrypts the note value
             * @member {Point}
             */
            this.gamma = bn128.curve.decodePoint(publicKey.slice(2, 68), 'hex');
            /**
             * AZTEC commitment point \sigma, a bn128 group element, encrypts the note value
             * @member {Point}
             */
            this.sigma = bn128.curve.decodePoint(publicKey.slice(68, 134), 'hex');
            /**
             * Note's metadata - general purpose property in which useful information can be stored.
             * By default it contains the note's ephemeral key - a secp256k1 group element which
             * the note owner can use to compute the note's viewing key.
             *
             * Arbitrary additional information can be later supplied, by calling setMetaData()
             */
            this.metaData = secp256k1.compress(secp256k1.ec.keyFromPublic(publicKey.slice(134, 200), 'hex').getPublic());
        }
        if (viewingKey) {
            if (typeof viewingKey !== 'string') {
                throw new Error(`expected key type ${typeof viewingKey} to be of type string`);
            }
            if (viewingKey.length !== 140) {
                throw new Error(`invalid viewing key length, expected 140, got ${viewingKey.length}`);
            }
            this.a = new BN(viewingKey.slice(2, 66), 16).toRed(bn128.groupReduction);
            this.k = new BN(viewingKey.slice(66, 74), 16).toRed(bn128.groupReduction);
            const { x, y } = setupPoint;
            const mu = bn128.curve.point(x, y);
            this.gamma = mu.mul(this.a);
            this.sigma = this.gamma.mul(this.k).add(bn128.h.mul(this.a));
            this.metaData = secp256k1.compress(secp256k1.ec.keyFromPublic(viewingKey.slice(74, 140), 'hex').getPublic());
        }
        /**
         * keccak256 hash of note coordinates, aligned in 32-byte chunks.
         *  Alignment is [gamma.x, gamma.y, sigma.x, sigma.y]
         * @member {string}
         */
        this.noteHash = getNoteHash(this.gamma, this.sigma);
    }

    /**
     * Compute value of a note, from the public key and the spending key
     *
     * @param {string} spendingKey the key that allows the holder to spend the note
     * @returns {string} hex-string concatenation of the note coordinates and the ephemeral key (compressed)
     */
    async derive(spendingKey) {
        const sharedSecret = getSharedSecret(this.ephemeralFromMetaData().getPublic(), spendingKey);
        this.a = new BN(sharedSecret.slice(2), 16).toRed(bn128.groupReduction);
        const gammaK = this.sigma.add(bn128.h.mul(this.a).neg());
        this.k = new BN(await bn128.recoverMessage(this.gamma, gammaK)).toRed(bn128.groupReduction);
    }

    /**
     * Export note's ephemeral key in compressed string form
     *
     * @returns {string} hex-string compressed ephemeral key
     */
    exportEphemeralKey() {
        return `0x${this.ephemeralFromMetaData().getPublic(true, 'hex')}`;
    }

    /**
     * Extract the ephemeralKey from the metaData and return it in secp256k1.ec key form
     */
    ephemeralFromMetaData() {
        return secp256k1.ec.keyFromPublic(secp256k1.decompressHex(this.metaData.slice(2, 68)), 'hex');
    }

    /**
     * Export the metaData of the note
     */
    exportMetaData() {
        const metaDataLength = this.metaData.slice(2).length / 2;
        return `${padLeft(metaDataLength, 64)}${this.metaData.slice(2)}`.slice(2);
    }

    /**
     * Export note coordinates in a form that can be used by proofs
     *
     * @returns {{ publicKey:string, viewingKey: string, k: string, a: string, noteHash: string }}
     */
    exportNote() {
        const publicKey = this.getPublic();
        const viewingKey = this.getView();
        let k = '0x';
        let a = '0x';
        if (BN.isBN(this.k)) {
            k = padLeft(this.k.fromRed().toString(16), 64);
        }
        if (BN.isBN(this.a)) {
            a = padLeft(this.a.fromRed().toString(16), 64);
        }
        return {
            publicKey,
            viewingKey,
            k,
            a,
            noteHash: this.noteHash,
        };
    }

    /**
     * Get the public key representation of a note
     *
     * @returns {string} hex-string concatenation of the note coordinates and the ephemeral key (compressed)
     */
    getPublic() {
        const ephemeral = this.ephemeralFromMetaData().getPublic();
        return noteCoder.encodeNotePublicKey({ gamma: this.gamma, sigma: this.sigma, ephemeral });
    }

    /**
     * Get the viewing key of a note
     *
     * @returns {string} hex-string concatenation of the note value and AZTEC viewing key
     */
    getView() {
        if (!BN.isBN(this.k) || !BN.isBN(this.a)) {
            return '0x';
        }
        const a = padLeft(this.a.fromRed().toString(16), 64);
        const k = padLeft(this.k.fromRed().toString(16), 8);
        const ephemeral = padLeft(this.ephemeralFromMetaData().getPublic(true, 'hex'), 66);
        return `0x${a}${k}${ephemeral}`;
    }

    /**
     * Appends custom metadata onto the metaData property of the note - i.e.e appends it onto end of the ephemeral key.
     * Also encodes it according to the schema for one note
     *
     * @param {String} customData
     * @returns {String} this.metaData - note metadata with the custom data appended
     *
     * Doing this with a fixed customData so far: 0x177 in length - length of one IES encrypted viewing key
     */
    setMetaData(customData) {
        this.metaData = this.metaData + padLeft(customData, 64).slice(2);
        return this.metaData;
    }
}

/**
 * Helper module to create Notes from public keys and view keys
 *
 * @module note
 */
const note = {};
note.utils = noteUtils;

/**
 * Create a Note instance from a recipient public key and a desired value
 *
 * @method fromValue
 * @param {string} publicKey hex-string formatted recipient public key
 * @param {number} value value of the note
 * @param {string} owner owner of the not if different from the public key
 * @returns {Promise} promise that resolves to created note instance
 */

note.create = async (spendingPublicKey, value, noteOwner) => {
    const sharedSecret = createSharedSecret(spendingPublicKey);
    const a = padLeft(new BN(sharedSecret.encoded.slice(2), 16).umod(bn128.curve.n).toString(16), 64);
    const k = padLeft(toHex(value).slice(2), 8);
    const ephemeral = padLeft(sharedSecret.ephemeralKey.slice(2), 66);
    const viewingKey = `0x${a}${k}${ephemeral}`;
    const owner = noteOwner || secp256k1.ecdsa.accountFromPublicKey(spendingPublicKey);
    const setupPoint = await setup.fetchPoint(value);
    return new Note(null, viewingKey, owner, setupPoint);
};

/**
 * Create a zero value note with from a constant `a` to make the hash of the initial totalMinted note in
 * mintable assets a constant
 *
 * @method createZeroValueNote
 * @returns {Promise} promise that resolves to created note instance
 */
note.createZeroValueNote = () => note.fromViewKey(noteUtils.constants.ZERO_VALUE_NOTE_VIEWING_KEY);

/**
 * Create Note instance from a public key and a spending key
 *
 * @dev This doesn't work in the web version of aztec.js
 *
 * @method derive
 * @param {string} publicKey hex-string formatted note public key
 * @param {string} spendingKey hex-string formatted spending key (can also be an Ethereum private key)
 * @returns {Promise} promise that resolves to created note instance
 */
note.derive = async (publicKey, spendingKey) => {
    const newNote = new Note(publicKey);
    await newNote.derive(spendingKey);
    return newNote;
};

/**
 * Encode compressed metadata of an array of notes as a hex-string, with each entry occupying 33 bytes
 *
 * @method fromValue
 * @param {string} publicKey hex-string formatted recipient public key
 * @param {number} value value of the note
 * @returns {Note} created note instance
 */
note.encodeMetadata = (noteArray) => {
    return noteArray.reduce((acc, aztecNote) => {
        const ephemeral = aztecNote.exportEphemeralKey();
        return `${acc}${padLeft(ephemeral.slice(2), 66)}`; // remove elliptic.js encoding byte, broadcast metadata is always compressed
    }, '0x');
};

/**
 * Create Note instance from an event log and a spending key
 *
 * @method fromEventLog
 * @param {string} logNoteData the note data returned from an event log
 * @returns {Note} created note instance
 */
note.fromEventLog = async (logNoteData, spendingKey = null) => {
    const publicKey = noteCoder.decodeNoteFromEventLog(logNoteData);
    const newNote = new Note(publicKey, null);
    if (spendingKey) {
        await newNote.derive(spendingKey);
    }
    return newNote;
};

/**
 * Create Note instance from a Note public key
 *
 * @method fromPublicKey
 * @param {string} publicKey the public key for the note
 * @returns {Note} created note instance
 */
note.fromPublicKey = (publicKey) => {
    return new Note(publicKey, null);
};

/**
 * Create Note instance from a viewing key
 *
 * @method fromViewKey
 * @param {string} viewingKey the viewing key for the note
 * @returns {Promise} promise that resolves to created note instance
 */
note.fromViewKey = async (viewingKey) => {
    const k = new BN(viewingKey.slice(66, 74), 16).toRed(bn128.groupReduction);
    const setupPoint = await setup.fetchPoint(k.toNumber());
    const newNote = new Note(null, viewingKey, undefined, setupPoint);
    return newNote;
};

/**
 * Create Note instance from a viewing key and public key
 *
 * @method fromViewPublicKey
 * @param {string} viewingKey the viewing key for the note
 * @param {string} publicKey the public key for the note
 * @returns {Promise} promise that resolves to created note instance
 */
note.fromViewPublicKey = async (viewingKey, publicKey) => {
    const k = new BN(viewingKey.slice(66, 74), 16).toRed(bn128.groupReduction);
    const setupPoint = await setup.fetchPoint(k.toNumber());
    const newNote = new Note(null, viewingKey, publicKey, setupPoint);
    return newNote;
};

/**
 * Export the Note class as part of the note module. We shouldn't really use this directly, but useful for testing purposes
 *
 * @memberof module:note
 */
note.Note = Note;

module.exports = note;
