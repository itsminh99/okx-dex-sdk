import { ethers } from "ethers";
import { SwapExecutor } from "../types";
import {
  SwapParams,
  SwapResponseData,
  SwapResult,
  ChainConfig,
  OKXConfig,
} from "../../../types";

export class EVMSwapExecutor implements SwapExecutor {
  private readonly provider: ethers.providers.JsonRpcProvider;
  private readonly DEFAULT_GAS_MULTIPLIER = ethers.BigNumber.from(150); // 1.5x

  constructor(
    private readonly config: OKXConfig,
    private readonly networkConfig: ChainConfig
  ) {
    if (!this.config.evm?.wallet) {
      throw new Error("EVM configuration required");
    }
    this.provider = this.config.evm.wallet.provider;
  }

  async executeSwap(
    swapData: SwapResponseData,
    params: SwapParams
  ): Promise<SwapResult> {
    const quoteData = swapData.data?.[0];
    if (!quoteData?.routerResult) {
      throw new Error("Invalid swap data: missing router result");
    }

    const { routerResult } = quoteData;
    const tx = quoteData.tx;
    if (!tx) {
      throw new Error("Missing transaction data");
    }

    try {
      const result = await this.executeEvmTransaction(tx);
      return this.formatSwapResult(result.transactionHash, routerResult);
    } catch (error) {
      console.error("Swap execution failed:", error);
      throw error;
    }
  }

  private async executeEvmTransaction(tx: any) {
    if (!this.config.evm?.wallet) {
      throw new Error("EVM wallet required");
    }

    let retryCount = 0;
    const maxRetries = this.networkConfig.maxRetries || 3;
    const gasMultiplier = ethers.BigNumber.from(110); //

    while (retryCount < maxRetries) {
      try {
        console.log("Preparing transaction...");

        const nonce = await this.provider.getTransactionCount("latest");

        const feeData = await this.provider.getFeeData();
        console.log("Fee data:", feeData);

        const baseFee = feeData.maxFeePerGas || ethers.BigNumber.from(0);
        const priorityFee =
          feeData.maxPriorityFeePerGas || ethers.BigNumber.from("3000000000"); // 3 gwei

        const transaction = {
          data: tx.data,
          to: tx.to,
          value: tx.value
            ? ethers.BigNumber.from(tx.value)
            : ethers.BigNumber.from(0),
          nonce: nonce + retryCount,
          gasLimit: ethers.BigNumber.from(tx.gas || 0)
            .mul(gasMultiplier)
            .div(ethers.BigNumber.from(100)),
          maxFeePerGas: baseFee
            .mul(gasMultiplier)
            .div(ethers.BigNumber.from(100)),
          maxPriorityFeePerGas: priorityFee
            .mul(gasMultiplier)
            .div(ethers.BigNumber.from(100)),
        };

        console.log("Transaction details:", {
          to: transaction.to,
          value: transaction.value.toString(),
          nonce: transaction.nonce,
          gasLimit: transaction.gasLimit.toString(),
          maxFeePerGas: transaction.maxFeePerGas.toString(),
          maxPriorityFeePerGas: transaction.maxPriorityFeePerGas.toString(),
        });

        console.log("Sending transaction...");
        const response = await this.config.evm.wallet.sendTransaction(
          transaction
        );
        console.log("Transaction sent! Hash:", response.hash);

        await new Promise((resolve) => setTimeout(resolve, 5000));

        console.log("Waiting for transaction confirmation...");
        let receipt = null;
        let attempts = 0;
        const maxAttempts = 30;

        while (attempts < maxAttempts) {
          receipt = await this.provider.getTransactionReceipt(response.hash);

          if (receipt) {
            console.log(
              "Transaction confirmed! Block number:",
              receipt.blockNumber
            );
            return receipt;
          }

          const pendingTx = await this.provider.getTransaction(response.hash);
          if (!pendingTx) {
            const network = await this.provider.getNetwork();
            console.error(
              `Transaction dropped. Network: ${network.name} (${network.chainId})`
            );
            throw new Error(
              "Transaction dropped - check network and gas prices"
            );
          }

          console.log(
            `Transaction still pending... (attempt ${
              attempts + 1
            }/${maxAttempts})`
          );
          await new Promise((resolve) => setTimeout(resolve, 2000));
          attempts++;
        }

        throw new Error(
          "Transaction confirmation timed out - check explorer for status"
        );
      } catch (error: any) {
        retryCount++;
        console.error(
          `Transaction attempt ${retryCount} failed:`,
          error.message
        );

        if (error.code === "INSUFFICIENT_FUNDS") {
          throw new Error("Insufficient funds for transaction");
        }
        if (error.code === "NONCE_EXPIRED") {
          throw new Error("Transaction nonce expired");
        }

        if (retryCount === maxRetries) {
          console.error("Max retries reached. Last error:", error);
          throw error;
        }

        const delay = 2000 * retryCount;
        console.log(`Retrying in ${delay}ms...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    throw new Error("Max retries exceeded");
  }

  private formatSwapResult(txHash: string, routerResult: any): SwapResult {
    const fromDecimals = parseInt(String(routerResult.fromToken.decimal));
    const toDecimals = parseInt(String(routerResult.toToken.decimal));

    const displayFromAmount = (
      Number(routerResult.fromTokenAmount) / Math.pow(10, fromDecimals)
    ).toFixed(6);

    const displayToAmount = (
      Number(routerResult.toTokenAmount) / Math.pow(10, toDecimals)
    ).toFixed(6);

    return {
      success: true,
      transactionId: txHash,
      explorerUrl: `${this.networkConfig.explorer}/${txHash}`,
      details: {
        fromToken: {
          symbol: routerResult.fromToken.tokenSymbol,
          amount: displayFromAmount,
          decimal: routerResult.fromToken.decimal,
        },
        toToken: {
          symbol: routerResult.toToken.tokenSymbol,
          amount: displayToAmount,
          decimal: routerResult.toToken.decimal,
        },
        priceImpact: routerResult.priceImpactPercentage,
      },
    };
  }
}
