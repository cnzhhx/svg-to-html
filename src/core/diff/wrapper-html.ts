type DiffWrapperHtmlOptions = {
  script: string
}

const createDiffWrapperHtml = ({ script }: DiffWrapperHtmlOptions) => `<!DOCTYPE html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <style>
      html, body {
        margin: 0;
        background: #000;
      }

      canvas {
        display: block;
      }
    </style>
  </head>
  <body>
    <canvas id="diff"></canvas>
    <script>
${script}
    </script>
  </body>
</html>
`

export { createDiffWrapperHtml }
