import { ethers } from "ethers";
import { SwapExecutor } from "../types";
import {
  SwapParams,
  SwapResponseData,
  SwapResult,
  ChainConfig,
  OKXConfig,
  APIResponse,
  ChainData,
} from "../../../types";
import { HTTPClient } from "../../../core/http-client";

// ERC20 ABI for approval
const ERC20_ABI = [
  {
    constant: true,
    inputs: [
      { name: "_owner", type: "address" },
      { name: "_spender", type: "address" },
    ],
    name: "allowance",
    outputs: [{ name: "", type: "uint256" }],
    type: "function",
  },
  {
    constant: false,
    inputs: [
      { name: "_spender", type: "address" },
      { name: "_value", type: "uint256" },
    ],
    name: "approve",
    outputs: [{ name: "", type: "bool" }],
    type: "function",
  },
];

export class EVMApproveExecutor implements SwapExecutor {
  private readonly provider: ethers.providers.JsonRpcProvider;
  private readonly DEFAULT_GAS_MULTIPLIER = ethers.BigNumber.from(150); // 1.5x
  private readonly httpClient: HTTPClient;

  constructor(
    private readonly config: OKXConfig,
    private readonly networkConfig: ChainConfig
  ) {
    if (!this.config.evm?.wallet) {
      throw new Error("EVM configuration required");
    }
    this.provider = this.config.evm.wallet.provider;
    this.httpClient = new HTTPClient(this.config);
  }

  async executeSwap(
    swapData: SwapResponseData,
    params: SwapParams
  ): Promise<SwapResult> {
    throw new Error("Swap execution not supported in approval executor");
  }

  private async getAllowance(
    tokenAddress: string,
    ownerAddress: string,
    spenderAddress: string
  ): Promise<ethers.BigNumber> {
    const tokenContract = new ethers.Contract(
      tokenAddress,
      ERC20_ABI,
      this.provider
    );
    return await tokenContract.allowance(ownerAddress, spenderAddress);
  }

  async handleTokenApproval(
    chainId: string,
    tokenAddress: string,
    amount: string
  ): Promise<{ transactionHash: string }> {
    if (!this.config.evm?.wallet) {
      throw new Error("EVM wallet required");
    }

    const dexContractAddress = await this.getDexContractAddress(chainId);

    // Check current allowance
    const currentAllowance = await this.getAllowance(
      tokenAddress,
      this.config.evm.wallet.address,
      dexContractAddress
    );

    const requiredAmount = ethers.BigNumber.from(amount);

    if (currentAllowance.gte(requiredAmount)) {
      throw new Error("Token already approved for the requested amount");
    }

    try {
      const result = await this.executeApprovalTransaction(
        tokenAddress,
        dexContractAddress,
        requiredAmount
      );

      return { transactionHash: result.transactionHash };
    } catch (error) {
      console.error("Approval execution failed:", error);
      throw error;
    }
  }

  private async getDexContractAddress(chainId: string): Promise<string> {
    try {
      const response = await this.httpClient.request<APIResponse<ChainData>>(
        "GET",
        "/api/v5/dex/aggregator/supported/chain",
        { chainId }
      );

      if (!response.data?.[0]?.dexTokenApproveAddress) {
        throw new Error(`No dex contract address found for chain ${chainId}`);
      }

      return response.data[0].dexTokenApproveAddress;
    } catch (error) {
      console.error("Error getting dex contract address:", error);
      throw error;
    }
  }

  private async executeApprovalTransaction(
    tokenAddress: string,
    spenderAddress: string,
    amount: ethers.BigNumber
  ) {
    if (!this.config.evm?.wallet) {
      throw new Error("EVM wallet required");
    }

    const wallet = this.config.evm.wallet;
    const tokenContract = new ethers.Contract(
      tokenAddress,
      ERC20_ABI,
      wallet as any
    );

    let retryCount = 0;
    const maxRetries = this.networkConfig.maxRetries || 3;

    while (retryCount < maxRetries) {
      try {
        console.log("Sending approval transaction...");

        const feeData = await this.provider.getFeeData();
        const baseFee = feeData.maxFeePerGas || ethers.BigNumber.from(0);
        const priorityFee =
          feeData.maxPriorityFeePerGas || ethers.BigNumber.from("3000000000"); // 3 gwei

        const tx = await tokenContract.approve(spenderAddress, amount, {
          gasLimit: ethers.BigNumber.from("100000"),
          maxFeePerGas: baseFee
            .mul(this.DEFAULT_GAS_MULTIPLIER)
            .div(ethers.BigNumber.from(100)),
          maxPriorityFeePerGas: priorityFee
            .mul(this.DEFAULT_GAS_MULTIPLIER)
            .div(ethers.BigNumber.from(100)),
        });

        console.log("Approval transaction sent. Hash:", tx.hash);

        const receipt = await tx.wait();
        console.log(
          "Approval transaction confirmed. Block:",
          receipt.blockNumber
        );

        return receipt;
      } catch (error) {
        retryCount++;
        console.warn(
          `Approval attempt ${retryCount} failed, retrying in ${
            2000 * retryCount
          }ms...`
        );
        if (retryCount === maxRetries) throw error;
        await new Promise((resolve) => setTimeout(resolve, 2000 * retryCount));
      }
    }

    throw new Error("Max retries exceeded for approval transaction");
  }
}
