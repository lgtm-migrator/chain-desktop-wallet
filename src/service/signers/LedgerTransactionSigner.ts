import sdk from '@crypto-org-chain/chain-jslib';
import { Bytes } from '@crypto-org-chain/chain-jslib/lib/dist/utils/bytes/bytes';
import { CosmosMsg } from '@crypto-org-chain/chain-jslib/lib/dist/transaction/msg/cosmosMsg';
import {
  TxBodyEncodeObject,
  Registry,
  makeAuthInfoBytes,
  encodePubkey,
  coin,
  // makeSignDoc,
  // makeSignBytes,
} from '@cosmjs/proto-signing';
import { encodeSecp256k1Pubkey, makeSignDoc, serializeSignDoc } from '@cosmjs/amino';
import { createBankAminoConverters, AminoTypes, MsgSendEncodeObject, MsgTransferEncodeObject, createIbcAminoConverters } from '@cosmjs/stargate';
import { TxRaw } from 'cosmjs-types/cosmos/tx/v1beta1/tx';
import { toHex } from '@crypto-org-chain/chain-jslib/node_modules/@cosmjs/encoding';
import Long from 'long';
import { Big, Units, Secp256k1KeyPair } from '../../utils/ChainJsLib';
import {
  DEFAULT_IBC_TRANSFER_TIMEOUT,
  SupportedChainName,
  WalletConfig,
} from '../../config/StaticConfig';
import {
  RestakeStakingRewardTransactionUnsigned,
  RestakeStakingAllRewardsTransactionUnsigned,
  TransactionUnsigned,
  DelegateTransactionUnsigned,
  TransferTransactionUnsigned,
  WithdrawStakingRewardUnsigned,
  UndelegateTransactionUnsigned,
  RedelegateTransactionUnsigned,
  VoteTransactionUnsigned,
  NFTTransferUnsigned,
  NFTMintUnsigned,
  NFTDenomIssueUnsigned,
  BridgeTransactionUnsigned,
  WithdrawAllStakingRewardsUnsigned,
  MsgDepositTransactionUnsigned,
  TextProposalTransactionUnsigned,
} from './TransactionSupported';
import { ISignerProvider } from './SignerProvider';
import { BaseTransactionSigner, ITransactionSigner } from './TransactionSigner';
import { isNumeric } from '../../utils/utils';
import { DerivationPathStandard } from './LedgerSigner';
import { MsgTransfer } from 'cosmjs-types/ibc/applications/transfer/v1/tx';

export class LedgerTransactionSigner extends BaseTransactionSigner implements ITransactionSigner {
  public readonly config: WalletConfig;

  public readonly signerProvider: ISignerProvider;

  public readonly addressIndex: number;

  public readonly derivationPathStandard: DerivationPathStandard;

  public registry: Registry;

  constructor(
    config: WalletConfig,
    signerProvider: ISignerProvider,
    addressIndex: number,
    derivationPathStandard: DerivationPathStandard,
  ) {
    super(config);
    this.config = config;
    this.signerProvider = signerProvider;
    this.addressIndex = addressIndex;
    this.derivationPathStandard = derivationPathStandard;
    this.registry = new Registry();
  }

  public getTransactionInfo(
    _phrase: string,
    transaction: TransactionUnsigned,
    gasFee: string,
    gasLimit: number,
  ) {
    const cro = sdk.CroSDK({ network: this.config.network });

    const rawTx = new cro.RawTransaction();
    const dummyPrivateKey = Bytes.fromBuffer(Buffer.alloc(32, 1));
    const keyPair = Secp256k1KeyPair.fromPrivKey(dummyPrivateKey);

    let { memo } = transaction;
    memo = memo.replace('&', '_');
    memo = memo.replace('<', '_');
    memo = memo.replace('>', '_');
    rawTx.setMemo(memo);

    const fee = new cro.Coin(gasFee, Units.BASE);

    rawTx.setFee(fee);
    rawTx.setGasLimit(gasLimit.toString());
    return { cro, rawTx, keyPair };
  }

  public async signTransfer(
    transaction: TransferTransactionUnsigned,
    phrase: string,
    gasFee: string,
    gasLimit: number,
  ): Promise<string> {
    if (
      transaction.asset?.config?.tendermintNetwork &&
      transaction.asset?.config?.tendermintNetwork?.chainName !== SupportedChainName.CRYPTO_ORG
    ) {
      const network = transaction.asset?.config?.tendermintNetwork;

      const fee = {
        amount: [
          {
            denom: network.coin.baseDenom,
            amount: gasFee,
          },
        ],
        gas: gasLimit,
      };

      const feeInAmino = {
        amount: [
          {
            denom: network.coin.baseDenom,
            amount: gasFee,
          },
        ],
        gas: gasLimit.toString(),
      };

      const pubkeyBytes = (
        await this.signerProvider.getPubKey(
          this.addressIndex,
          network.chainName!,
          this.derivationPathStandard,
          false,
        )
      ).toUint8Array();

      // this is 34 bytes, 33 length itself, 0x02 pr 0x03
      // cut first byte of pubkeyBytes
      // pubkeyBytes is 34 bytes, first byte is length itself, 33
      const pubkeyBytesInLength33 = pubkeyBytes.slice(1);
      const pubkey = encodePubkey(encodeSecp256k1Pubkey(pubkeyBytesInLength33));

      // amino json auto info bytes
      const authInfoBytes = makeAuthInfoBytes(
        [{ pubkey, sequence: transaction.accountSequence }],
        fee.amount,
        fee.gas,
        127,
      );

      const chainId = network.chainId ?? '';

      const msgSend: MsgSendEncodeObject = {
        typeUrl: '/cosmos.bank.v1beta1.MsgSend',
        value: {
          fromAddress: transaction.fromAddress,
          toAddress: transaction.toAddress,
          amount: [
            {
              denom: network.coin.baseDenom,
              amount: String(transaction.amount),
            },
          ],
        },
      };

      const converter = new AminoTypes(createBankAminoConverters());
      const msgSendInAmino = converter.toAmino(msgSend);

      const signedTxBody = {
        messages: [msgSend],
        memo: transaction.memo,
      };
      const signedTxBodyEncodeObject: TxBodyEncodeObject = {
        typeUrl: '/cosmos.tx.v1beta1.TxBody',
        value: signedTxBody,
      };
      const signedTxBodyBytes = this.registry.encode(signedTxBodyEncodeObject);

      const signDoc = makeSignDoc(
        [msgSendInAmino],
        feeInAmino,
        chainId,
        transaction.memo,
        transaction.accountNumber,
        transaction.accountSequence,
      );
      const uint8SignDoc = serializeSignDoc(signDoc);
      const messageByte = new Bytes(uint8SignDoc);

      const signature = await this.signerProvider.sign(messageByte);

      const txRaw = TxRaw.fromPartial({
        bodyBytes: signedTxBodyBytes,
        authInfoBytes,
        signatures: [signature.toUint8Array()],
      });

      // get signed tx from TxRaw
      const signedBytes = Uint8Array.from(TxRaw.encode(txRaw).finish());
      const txHash = toHex(signedBytes);
      return txHash;
    }
    const { cro, rawTx } = this.getTransactionInfo(phrase, transaction, gasFee, gasLimit);

    const msgSend = new cro.bank.MsgSend({
      fromAddress: transaction.fromAddress,
      toAddress: transaction.toAddress,
      amount: new cro.Coin(transaction.amount, Units.BASE),
    });

    return this.getSignedMessageTransaction(transaction, [msgSend], rawTx);
  }

  public async signVoteTransaction(
    transaction: VoteTransactionUnsigned,
    phrase: string,
    gasFee: string,
    gasLimit: number,
  ): Promise<string> {
    const { cro, rawTx } = this.getTransactionInfo(phrase, transaction, gasFee, gasLimit);

    const msgVote = new cro.gov.MsgVote({
      voter: transaction.voter,
      option: transaction.option,
      proposalId: Big(transaction.proposalID),
    });

    return this.getSignedMessageTransaction(transaction, [msgVote], rawTx);
  }

  /**
   * Sign a raw `MsgDeposit` tx for onchain submission
   * @param transaction
   * @param phrase
   * @param gasFee
   * @param gasLimit
   */
  public async signProposalDepositTransaction(
    transaction: MsgDepositTransactionUnsigned,
    phrase: string,
    gasFee: string,
    gasLimit: number,
  ): Promise<string> {
    const { cro, rawTx } = this.getTransactionInfo(phrase, transaction, gasFee, gasLimit);

    // Transforming user amount to library compatible type
    const msgDepositAmount = transaction.amount.map(coin => {
      return cro.v2.CoinV2.fromCustomAmountDenom(coin.amount, coin.denom);
    });

    // Using V2 because it has support for multiple `amount` in a single transaction
    const msgDeposit = new cro.v2.gov.MsgDepositV2({
      amount: msgDepositAmount,
      depositor: transaction.depositor,
      proposalId: Big(transaction.proposalId),
    });

    return this.getSignedMessageTransaction(transaction, [msgDeposit], rawTx);
  }

  /**
   * Sign a raw `MsgSubmitProposal.TextProposal` tx for onchain submission
   * @param transaction
   * @param phrase
   * @param gasFee
   * @param gasLimit
   */
  public async signSubmitTextProposalTransaction(
    transaction: TextProposalTransactionUnsigned,
    phrase: string,
    gasFee: string,
    gasLimit: number,
  ): Promise<string> {
    const { cro, rawTx } = this.getTransactionInfo(phrase, transaction, gasFee, gasLimit);

    // Converting `initialDeposit` to library compatible types
    const initialDepositTyped = transaction.initialDeposit.map(coin => {
      return cro.v2.CoinV2.fromCustomAmountDenom(coin.amount, coin.denom);
    });

    // Constucting a Msg TextProposal
    const submitTextProposalContent = new cro.gov.proposal.TextProposal(transaction.params);

    // Using V2 because it has support for multiple `amount` in a single transaction
    const msgSubmitProposal = new cro.v2.gov.MsgSubmitProposalV2({
      initialDeposit: initialDepositTyped,
      proposer: transaction.proposer,
      content: submitTextProposalContent,
    });

    return this.getSignedMessageTransaction(transaction, [msgSubmitProposal], rawTx);
  }

  public async signDelegateTx(
    transaction: DelegateTransactionUnsigned,
    phrase: string,
    gasFee: string,
    gasLimit: number,
  ): Promise<string> {
    const { cro, rawTx } = this.getTransactionInfo(phrase, transaction, gasFee, gasLimit);

    const delegateAmount = new cro.Coin(transaction.amount, Units.BASE);
    const msgDelegate = new cro.staking.MsgDelegate({
      delegatorAddress: transaction.delegatorAddress,
      validatorAddress: transaction.validatorAddress,
      amount: delegateAmount,
    });

    return this.getSignedMessageTransaction(transaction, [msgDelegate], rawTx);
  }

  public async signRestakeStakingRewardTx(
    transaction: RestakeStakingRewardTransactionUnsigned,
    phrase: string,
    gasFee: string,
    gasLimit: number,
  ): Promise<string> {
    const { cro, rawTx } = this.getTransactionInfo(phrase, transaction, gasFee, gasLimit);

    const delegateAmount = new cro.Coin(transaction.amount, Units.BASE);
    const msgWithdraw = new cro.distribution.MsgWithdrawDelegatorReward({
      delegatorAddress: transaction.delegatorAddress,
      validatorAddress: transaction.validatorAddress,
    });

    const msgDelegate = new cro.staking.MsgDelegate({
      delegatorAddress: transaction.delegatorAddress,
      validatorAddress: transaction.validatorAddress,
      amount: delegateAmount,
    });

    return this.getSignedMessageTransaction(transaction, [msgWithdraw, msgDelegate], rawTx);
  }

  public async signRestakeAllStakingRewardsTx(
    transaction: RestakeStakingAllRewardsTransactionUnsigned,
    phrase: string,
    gasFee: string,
    gasLimit: number,
  ): Promise<string> {
    const { cro, rawTx } = this.getTransactionInfo(phrase, transaction, gasFee, gasLimit);

    const msgWithdrawAllDelegatorRewards = transaction.validatorAddressList.map(
      validatorAddress => {
        return new cro.distribution.MsgWithdrawDelegatorReward({
          delegatorAddress: transaction.delegatorAddress,
          validatorAddress,
        });
      },
    );

    const msgDelegation = transaction.validatorAddressList.map((validatorAddress, idx) => {
      const delegateAmount = new cro.Coin(transaction.amountList[idx], Units.BASE);

      return new cro.staking.MsgDelegate({
        delegatorAddress: transaction.delegatorAddress,
        validatorAddress,
        amount: delegateAmount,
      });
    });

    return this.getSignedMessageTransaction(
      transaction,
      [...msgWithdrawAllDelegatorRewards, ...msgDelegation],
      rawTx,
    );
  }

  public async signWithdrawStakingRewardTx(
    transaction: WithdrawStakingRewardUnsigned,
    phrase: string,
    gasFee: string,
    gasLimit: number,
  ): Promise<string> {
    const { cro, rawTx } = this.getTransactionInfo(phrase, transaction, gasFee, gasLimit);

    const msgWithdrawDelegatorReward = new cro.distribution.MsgWithdrawDelegatorReward({
      delegatorAddress: transaction.delegatorAddress,
      validatorAddress: transaction.validatorAddress,
    });

    return this.getSignedMessageTransaction(transaction, [msgWithdrawDelegatorReward], rawTx);
  }

  /**
   *
   * @param transaction
   * @param phrase
   * @param gasFee
   * @param gasLimit
   */
  public async signWithdrawAllStakingRewardsTx(
    transaction: WithdrawAllStakingRewardsUnsigned,
    phrase: string,
    gasFee: string,
    gasLimit: number,
  ): Promise<string> {
    const { cro, rawTx } = this.getTransactionInfo(phrase, transaction, gasFee, gasLimit);

    const msgWithdrawAllDelegatorRewards = transaction.validatorAddressList.map(
      validatorAddress => {
        return new cro.distribution.MsgWithdrawDelegatorReward({
          delegatorAddress: transaction.delegatorAddress,
          validatorAddress,
        });
      },
    );

    return this.getSignedMessageTransaction(transaction, msgWithdrawAllDelegatorRewards, rawTx);
  }

  public async signUndelegateTx(
    transaction: UndelegateTransactionUnsigned,
    phrase: string,
    gasFee: string,
    gasLimit: number,
  ): Promise<string> {
    const { cro, rawTx } = this.getTransactionInfo(phrase, transaction, gasFee, gasLimit);

    const msgUndelegate = new cro.staking.MsgUndelegate({
      delegatorAddress: transaction.delegatorAddress,
      validatorAddress: transaction.validatorAddress,
      amount: new cro.Coin(transaction.amount, Units.BASE),
    });

    return this.getSignedMessageTransaction(transaction, [msgUndelegate], rawTx);
  }

  public async signRedelegateTx(
    transaction: RedelegateTransactionUnsigned,
    phrase: string,
    gasFee: string,
    gasLimit: number,
  ): Promise<string> {
    const { cro, rawTx } = this.getTransactionInfo(phrase, transaction, gasFee, gasLimit);

    const msgBeginRedelegate = new cro.staking.MsgBeginRedelegate({
      delegatorAddress: transaction.delegatorAddress,
      validatorSrcAddress: transaction.sourceValidatorAddress,
      validatorDstAddress: transaction.destinationValidatorAddress,
      amount: new cro.Coin(transaction.amount, Units.BASE),
    });

    return this.getSignedMessageTransaction(transaction, [msgBeginRedelegate], rawTx);
  }

  async signNFTTransfer(
    transaction: NFTTransferUnsigned,
    decryptedPhrase: string,
    gasFee: string,
    gasLimit: number,
  ) {
    const { cro, rawTx } = this.getTransactionInfo(decryptedPhrase, transaction, gasFee, gasLimit);

    const msgTransferNFT = new cro.nft.MsgTransferNFT({
      id: transaction.tokenId,
      sender: transaction.sender,
      denomId: transaction.denomId,
      recipient: transaction.recipient,
    });

    return this.getSignedMessageTransaction(transaction, [msgTransferNFT], rawTx);
  }

  async signNFTMint(
    transaction: NFTMintUnsigned,
    decryptedPhrase: string,
    gasFee: string,
    gasLimit: number,
  ) {
    const { cro, rawTx } = this.getTransactionInfo(decryptedPhrase, transaction, gasFee, gasLimit);

    const msgMintNFT = new cro.nft.MsgMintNFT({
      id: transaction.tokenId,
      name: transaction.name,
      sender: transaction.sender,
      denomId: transaction.denomId,
      uri: transaction.uri,
      data: transaction.data,
      recipient: transaction.recipient,
    });

    return this.getSignedMessageTransaction(transaction, [msgMintNFT], rawTx);
  }

  async signNFTDenomIssue(
    transaction: NFTDenomIssueUnsigned,
    decryptedPhrase: string,
    gasFee: string,
    gasLimit: number,
  ) {
    const { cro, rawTx } = this.getTransactionInfo(decryptedPhrase, transaction, gasFee, gasLimit);

    const msgIssueDenom = new cro.nft.MsgIssueDenom({
      id: transaction.denomId,
      name: transaction.name,
      sender: transaction.sender,
      schema: transaction.schema,
    });

    return this.getSignedMessageTransaction(transaction, [msgIssueDenom], rawTx);
  }

  async getSignedMessageTransaction(transaction: TransactionUnsigned, message: CosmosMsg[], rawTx) {
    const pubkeyoriginal = (
      await this.signerProvider.getPubKey(
        this.addressIndex,
        transaction.asset?.config?.tendermintNetwork?.chainName ?? SupportedChainName.CRYPTO_ORG,
        this.derivationPathStandard,
        false,
      )
    ).toUint8Array();
    const pubkey = Bytes.fromUint8Array(pubkeyoriginal.slice(1));
    /* 
    SIGN_MODE_UNSPECIFIED = 0,
    SIGN_MODE_DIRECT = 1,
    SIGN_MODE_TEXTUAL = 2,
    SIGN_MODE_LEGACY_AMINO_JSON = 127,
    */

    // Appending cosmos messages to raw transaction
    message.forEach(msg => {
      rawTx.appendMessage(msg);
    });

    const signableTx = rawTx
      .addSigner({
        publicKey: pubkey,
        accountNumber: new Big(transaction.accountNumber),
        accountSequence: new Big(transaction.accountSequence),
        signMode: 127, // LEGACY_AMINO_JSON = 127, DIRECT = 1,
      })
      .toSignable();

    // 0: signer index
    const bytesMessage: Bytes = signableTx.toSignDocument(0);
    console.log('cosmosHub bytesMessage', bytesMessage);
    const signature = await this.signerProvider.sign(bytesMessage);
    console.log('cosmosHub signature', signature);
    console.log(
      'signableTxHash',
      signableTx
        .setSignature(0, signature)
        .toSigned()
        .getHexEncoded(),
    );

    return signableTx
      .setSignature(0, signature)
      .toSigned()
      .getHexEncoded();
  }

  public StaticRevisionNumber = 122;

  public StaticBigLatestHeight = 120_000_000;

  public async signIBCTransfer(
    transaction: BridgeTransactionUnsigned,
    phrase: string,
    gasFee: string,
    gasLimit: number,
  ): Promise<string> {
    if (
      transaction.originAsset?.config?.tendermintNetwork &&
      transaction.originAsset?.config?.tendermintNetwork?.chainName !== SupportedChainName.CRYPTO_ORG
    ) {
      const typeUrlIBCTransfer = '/ibc.applications.transfer.v1.MsgTransfer';
      const network = transaction.originAsset?.config?.tendermintNetwork;

      const fee = {
        amount: [
          {
            denom: network.coin.baseDenom,
            amount: gasFee,
          },
        ],
        gas: gasLimit,
      };

      const feeInAmino = {
        amount: [
          {
            denom: network.coin.baseDenom,
            amount: gasFee,
          },
        ],
        gas: gasLimit.toString(),
      };

      const pubkeyBytes = (
        await this.signerProvider.getPubKey(
          this.addressIndex,
          network.chainName!,
          this.derivationPathStandard,
          false,
        )
      ).toUint8Array();

      // this is 34 bytes, 33 length itself, 0x02 pr 0x03
      // cut first byte of pubkeyBytes
      // pubkeyBytes is 34 bytes, first byte is length itself, 33
      const pubkeyBytesInLength33 = pubkeyBytes.slice(1);
      const pubkey = encodePubkey(encodeSecp256k1Pubkey(pubkeyBytesInLength33));

      // amino json auto info bytes
      const authInfoBytes = makeAuthInfoBytes(
        [{ pubkey, sequence: transaction.accountSequence }],
        fee.amount,
        fee.gas,
        127,
      );

      const chainId = network.chainId ?? '';

      const millisToNanoSecond = 1_000_000;
      const timeout = (Date.now() + DEFAULT_IBC_TRANSFER_TIMEOUT) * millisToNanoSecond;

      const msg = MsgTransfer.fromPartial({
        sourcePort: transaction.port || '',
        sourceChannel: transaction.channel || '',
        token: coin(transaction.amount, network.coin.baseDenom),
        sender: transaction.fromAddress,
        receiver: transaction.toAddress,
        timeoutTimestamp: Long.fromString(String(timeout), true),
      });

      const msgTransfer: MsgTransferEncodeObject = {
        typeUrl: typeUrlIBCTransfer,
        value: msg,
      };

      const converter = new AminoTypes(createIbcAminoConverters());
      const msgTransferInAmino = converter.toAmino(msgTransfer);

      const signedTxBody = {
        messages: [msgTransfer],
        memo: transaction.memo,
      };
      const signedTxBodyEncodeObject: TxBodyEncodeObject = {
        typeUrl: '/cosmos.tx.v1beta1.TxBody',
        value: signedTxBody,
      };
      
      this.registry.register(typeUrlIBCTransfer, MsgTransfer);

      const signedTxBodyBytes = this.registry.encode(signedTxBodyEncodeObject);

      const signDoc = makeSignDoc(
        [msgTransferInAmino],
        feeInAmino,
        chainId,
        transaction.memo,
        transaction.accountNumber,
        transaction.accountSequence,
      );
      const uint8SignDoc = serializeSignDoc(signDoc);
      const messageByte = new Bytes(uint8SignDoc);

      const signature = await this.signerProvider.sign(messageByte);

      const txRaw = TxRaw.fromPartial({
        bodyBytes: signedTxBodyBytes,
        authInfoBytes,
        signatures: [signature.toUint8Array()],
      });

      // get signed tx from TxRaw
      const signedBytes = Uint8Array.from(TxRaw.encode(txRaw).finish());
      const txHash = toHex(signedBytes);
      return txHash;

    }
    const { cro, rawTx } = this.getTransactionInfoData(phrase, transaction.memo, gasFee, gasLimit);

    const millisToNanoSecond = 1_000_000;
    const timeout = (Date.now() + DEFAULT_IBC_TRANSFER_TIMEOUT) * millisToNanoSecond;

    // For a chainID string like testnet-croeseid-4, revision number is 4
    const revisionNumberFromChainID = transaction?.originAsset?.config?.chainId?.split('-').pop();
    const revisionNumber = isNumeric(revisionNumberFromChainID)
      ? revisionNumberFromChainID
      : this.StaticRevisionNumber;

    // Latest block plus arbitrary number of blocks on top
    const revisionHeight = Big(transaction.latestBlockHeight || this.StaticBigLatestHeight).plus(
      250,
    );

    const msgSend = new cro.ibc.MsgTransfer({
      sender: transaction.fromAddress,
      sourceChannel: transaction.channel || '',
      sourcePort: transaction.port || '',
      timeoutTimestampInNanoSeconds: Long.fromValue(timeout),
      timeoutHeight: {
        revisionNumber: Long.fromString(String(revisionNumber), true),
        revisionHeight: Long.fromString(revisionHeight.toFixed(), true),
      },
      receiver: transaction.toAddress,
      token: new cro.Coin(transaction.amount, Units.BASE),
    });

    return this.getSignedMessageTransaction(transaction, [msgSend], rawTx);
  }
}
