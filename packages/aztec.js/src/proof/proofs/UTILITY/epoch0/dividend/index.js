const bn128 = require('@aztec/bn128');
const { constants, errors, proofs } = require('@aztec/dev-utils');
const BN = require('bn.js');
const AbiCoder = require('web3-eth-abi');
const { keccak256, padLeft } = require('web3-utils');

const { inputCoder, outputCoder } = require('../../../../../encoder');
const Proof = require('../../../../base/epoch0/proof');
const ProofType = require('../../../../base/types');
const ProofUtils = require('../../../../base/epoch0/utils');

const { AztecError } = errors;

class DividendProof66561 extends Proof {
    /**
     * Constructs a Dividend proof. It is assumed that it is in the prover's interest for `targetNote` to be
     * as large as possible. What we are actually checking, is that `targetNote` <= (`zb` / `za`) * `notionalNote`.
     * If they desire, a prover can create a `targetNote` that is smaller than the note they are entitled to.
     *
     * @param {Object} notionalNote the note that one is computing a dividend of
     * @param {Object} residualNote the note that represents the integer rounding error
     * @param {Object} targetNote the note that is being produced
     * @param {string} sender
     * @param {Number} za numerator for the ratio between notionalNote and targetNote
     * @param {Number} zb denominator for the ratio between notionalNote and targetNote
     */
    constructor(notionalNote, residualNote, targetNote, sender, za, zb) {
        const publicValue = constants.ZERO_BN;
        const publicOwner = constants.addresses.ZERO_ADDRESS;
        super(ProofType.DIVIDEND.name, [notionalNote], [residualNote, targetNote], sender, publicValue, publicOwner);

        this.za = new BN(za);
        this.zb = new BN(zb);

        this.constructBlindingFactors();
        this.constructChallenge();
        this.constructData();
        this.constructOutputs();
    }

    constructBlindingFactors() {
        const blindingScalars = Array(this.notes.length)
            .fill()
            .map(() => {
                return {
                    bk: bn128.randomGroupScalar(),
                    ba: bn128.randomGroupScalar(),
                };
            });

        let reducer = this.rollingHash.redKeccak(); // "x" in the white paper
        this.blindingFactors = this.notes.map((note, i) => {
            let { bk } = blindingScalars[i];
            const { ba } = blindingScalars[i];

            if (i === 2) {
                const zaRed = this.za.toRed(bn128.groupReduction);
                const zbRed = this.zb.toRed(bn128.groupReduction);

                // bk_3 = (z_b)(bk_1) - (z_a)(bk_2)
                bk = zbRed.redMul(blindingScalars[0].bk).redSub(zaRed.redMul(blindingScalars[1].bk));
            }

            const xbk = bk.redMul(reducer); // xbk = bk*x
            const xba = ba.redMul(reducer); // xba = ba*x
            const B = note.gamma.mul(xbk).add(bn128.h.mul(xba));
            reducer = this.rollingHash.redKeccak();
            return { B, bk, ba };
        });
    }

    constructChallenge() {
        this.constructChallengeRecurse([this.sender, this.za, this.zb, this.notes, this.blindingFactors]);
        this.challenge = this.challengeHash.redKeccak();
    }

    constructData() {
        this.data = this.blindingFactors.map(({ bk, ba }, i) => {
            const note = this.notes[i];
            const kBar = note.k
                .redMul(this.challenge)
                .redAdd(bk)
                .fromRed();
            const aBar = note.a
                .redMul(this.challenge)
                .redAdd(ba)
                .fromRed();

            const items = [
                kBar,
                aBar,
                note.gamma.x.fromRed(),
                note.gamma.y.fromRed(),
                note.sigma.x.fromRed(),
                note.sigma.y.fromRed(),
            ];
            return items.map((item) => `0x${padLeft(item.toString(16), 64)}`);
        });
    }

    // TODO: normalise proof output encoding. In some places it's expected to use `encodeProofOutputs`
    // while in others `encodeProofOutput`.
    constructOutputs() {
        const proofOutput = {
            inputNotes: this.inputNotes,
            outputNotes: this.outputNotes,
            publicValue: this.publicValue,
            publicOwner: this.publicOwner,
            challenge: this.challengeHex,
        };
        this.output = outputCoder.encodeProofOutput(proofOutput);
        this.outputs = outputCoder.encodeProofOutputs([proofOutput]);
        this.hash = outputCoder.hashProofOutput(this.output);
        this.validatedProofHash = keccak256(
            AbiCoder.encodeParameters(['bytes32', 'uint24', 'address'], [this.hash, proofs.DIVIDEND_PROOF, this.sender]),
        );
    }

    encodeABI() {
        const encodedParams = [
            inputCoder.encodeProofData(this.data),
            inputCoder.encodeOwners(this.inputNoteOwners),
            inputCoder.encodeOwners(this.outputNoteOwners),
            inputCoder.encodeMetaData(this.outputNotes),
        ];

        const length = 3 + encodedParams.length + 1;
        const offsets = ProofUtils.getOffsets(length, encodedParams);
        const abiEncodedParams = [
            this.challengeHex.slice(2),
            padLeft(this.za.toString(16), 64),
            padLeft(this.zb.toString(16), 64),
            ...offsets,
            ...encodedParams,
        ];
        return `0x${abiEncodedParams.join('').toLowerCase()}`;
    }

    validateInputs() {
        super.validateInputs();
        if (this.notes.length !== 3) {
            throw new AztecError(errors.codes.INCORRECT_NOTE_NUMBER, {
                message: `Dividend proofs must contain 3 notes`,
                numNotes: this.notes.length,
            });
        }
    }
}

module.exports = DividendProof66561;
