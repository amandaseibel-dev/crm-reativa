import * as XLSX from "xlsx";

export async function lerBaseAnalitica(arquivo) {
  const buffer = await arquivo.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: "array" });

  const resultado = {};

  workbook.SheetNames.forEach((nomeAba) => {
    const planilha = workbook.Sheets[nomeAba];
    const dados = XLSX.utils.sheet_to_json(planilha, { defval: "" });

    resultado[nomeAba] = {
      totalLinhas: dados.length,
      colunas: dados.length > 0 ? Object.keys(dados[0]) : [],
      dados,
    };
  });

  return resultado;
}