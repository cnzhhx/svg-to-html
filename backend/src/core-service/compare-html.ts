const COMPARE_OPTIMIZED_MARKER = "data-gateway-compare-optimized";

const COMPARE_LOADING_STYLES = `
    <style ${COMPARE_OPTIMIZED_MARKER}>
      .compare-stage {
        position: relative;
        background: #f8fafc;
      }

      .compare-stage > img,
      .compare-stage > iframe {
        position: relative;
        z-index: 1;
      }

      .compare-loading {
        position: absolute;
        inset: 0;
        z-index: 2;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: flex-start;
        gap: 12px;
        padding-top: 160px;
        color: #64748b;
        background: #f8fafc;
        font-size: 16px;
        line-height: 24px;
      }

      .compare-loading::before {
        width: 24px;
        height: 24px;
        border: 3px solid #cbd5e1;
        border-top-color: #0ea5e9;
        border-radius: 50%;
        content: "";
        animation: compare-loading-spin 0.8s linear infinite;
      }

      .compare-stage[data-load-state="loaded"] > .compare-loading {
        display: none;
      }

      .compare-stage[data-load-state="error"] > .compare-loading {
        color: #dc2626;
      }

      .compare-stage[data-load-state="error"] > .compare-loading::before {
        display: none;
      }

      @keyframes compare-loading-spin {
        to { transform: rotate(360deg); }
      }
    </style>`;

const COMPARE_LOADING_SCRIPT = `
    <script ${COMPARE_OPTIMIZED_MARKER}>
      (() => {
        document.querySelectorAll(".compare-stage").forEach((stage) => {
          const media = stage.querySelector("img, iframe");
          if (!media) return;

          const isImage = media.tagName === "IMG";
          const loading = document.createElement("div");
          loading.className = "compare-loading";
          loading.setAttribute("role", "status");
          loading.textContent = isImage ? "高保真稿加载中..." : "代码还原加载中...";
          stage.prepend(loading);

          const markLoaded = () => {
            stage.dataset.loadState = "loaded";
          };
          let fallbackTried = false;
          const markFailed = () => {
            const fallbackSrc = isImage ? media.dataset.fallbackSrc : "";
            if (fallbackSrc && !fallbackTried) {
              fallbackTried = true;
              loading.textContent = "正在加载原始 SVG...";
              media.src = fallbackSrc;
              return;
            }
            stage.dataset.loadState = "error";
            loading.textContent = "加载失败，请刷新页面重试";
          };

          media.addEventListener("load", markLoaded, { once: true });
          media.addEventListener("error", markFailed);
          if (isImage && media.complete) {
            if (media.naturalWidth > 0) markLoaded();
            else markFailed();
          }
        });
      })();
    </script>`;

const replaceSvgPreview = (html: string) =>
  html.replace(
    /(<img\b[^>]*\bsrc=")(.\/[^"?]+\.svg)(\?[^\"]*)?("[^>]*>)/i,
    (_match, prefix: string, svgPath: string, query: string | undefined, tail: string) => {
      const suffix = query ?? "";
      return `${prefix}./artifacts/svg.png${suffix}" data-fallback-src="${svgPath}${suffix}" fetchpriority="high"${tail.slice(1)}`;
    },
  );

const optimizeCompareHtml = (html: string) => {
  if (
    !html.includes('class="compare-stage"') ||
    html.includes(COMPARE_OPTIMIZED_MARKER)
  ) {
    return html;
  }

  const withPreview = replaceSvgPreview(html);
  const withStyles = withPreview.includes("</head>")
    ? withPreview.replace("</head>", `${COMPARE_LOADING_STYLES}\n  </head>`)
    : `${COMPARE_LOADING_STYLES}\n${withPreview}`;
  return withStyles.includes("</body>")
    ? withStyles.replace("</body>", `${COMPARE_LOADING_SCRIPT}\n  </body>`)
    : `${withStyles}\n${COMPARE_LOADING_SCRIPT}`;
};

export { optimizeCompareHtml };
