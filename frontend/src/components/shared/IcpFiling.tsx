/**
 * 网站 ICP 备案悬挂位。
 *
 * 合规依据：《非经营性互联网信息服务备案管理办法》（原信息产业部令第 33 号）第十三条 ——
 * 非经营性互联网信息服务提供者应当在其网站开通时在主页底部的中央位置标明其备案编号，
 * 并在备案编号下方按要求链接信息产业部备案管理系统网址 https://beian.miit.gov.cn/，
 * 供公众查询核对。未悬挂或未链接者，由住所所在地省通信管理局责令改正并处罚款。
 *
 * 备案号是法定标识，不随界面语言切换，因此不进 i18n 文案文件。
 */

/** 安徽（皖）管局按主体备案号悬挂，故不带网站序号（-1 / -2）。 */
export const ICP_FILING_NUMBER = "皖ICP备2026029804号";

/** 工信部 ICP/IP 地址/域名信息备案管理系统。 */
export const ICP_FILING_URL = "https://beian.miit.gov.cn/";

type IcpFilingLinkProps = {
  className?: string;
};

export function IcpFilingLink({ className = "" }: IcpFilingLinkProps) {
  return (
    <a
      href={ICP_FILING_URL}
      target="_blank"
      rel="noopener noreferrer"
      className={`group inline-flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background ${className}`}
    >
      {/*
        备案标识徽章：细描边盾牌 + 对勾，currentColor 跟随文本色，
        hover 时整体轻微变深，避免纯文字链接看起来像调试输出。
      */}
      <svg
        width="12"
        height="14"
        viewBox="0 0 12 14"
        aria-hidden="true"
        className="shrink-0 transition-transform duration-200 group-hover:-translate-y-px"
      >
        <path
          d="M6 0.75 L10.75 2.5 L10.75 7 C10.75 9.9 8.9 12.4 6 13.25 C3.1 12.4 1.25 9.9 1.25 7 L1.25 2.5 Z"
          stroke="currentColor"
          strokeWidth="1.1"
          fill="none"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        <path
          d="M4 6.85 L5.4 8.25 L8.05 5.45"
          stroke="currentColor"
          strokeWidth="1.1"
          fill="none"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      </svg>
      {/*
        强制走 CJK 字体并启用 tabular-nums，让"皖/号"与"2026029804"
        共享同一套字模与基线 —— 混排 Inter 数字 + Noto Sans SC 汉字是
        之前视觉参差的根因。
      */}
      <span
        className="leading-none"
        style={{
          fontFamily:
            '"Noto Sans SC", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif',
          fontFeatureSettings: '"tnum" 1, "kern" 1',
          fontVariantNumeric: "tabular-nums"
        }}
      >
        {ICP_FILING_NUMBER}
      </span>
    </a>
  );
}

export default IcpFilingLink;