// Exportacao de Acoes Massivas: montagem das linhas, geracao do arquivo e classificacao de falhas.
// Nao registra nomes, contatos, tokens nem conteudo exportado. Erros carregam so a etapa e um codigo.

// Codigos de erro de validacao devolvidos pela RPC (SQLSTATE usados em acoes_massivas_exportar).
const CODIGOS_VALIDACAO = new Set(["22023", "42501", "P0002"]);

/** Classifica uma falha em uma de tres etapas: validacao, rpc ou arquivo. */
export function classificarFalhaExportacao(etapa, erro) {
  const codigo = erro?.code ?? erro?.status ?? null;
  if (etapa === "arquivo") {
    return { etapa: "arquivo", codigo: null, mensagem: "O arquivo não pôde ser gerado no navegador. O lote já foi registrado; use Baixar planilha." };
  }
  if (etapa === "rpc" && codigo && CODIGOS_VALIDACAO.has(String(codigo))) {
    return { etapa: "validacao", codigo: String(codigo), mensagem: "A exportação foi recusada pela validação. Gere a prévia de novo e tente outra vez." };
  }
  return { etapa: "rpc", codigo: codigo ? String(codigo) : null, mensagem: "O servidor não confirmou a exportação. Não é possível afirmar que o lote foi registrado; verifique antes de repetir." };
}

/** Monta as linhas da planilha a partir dos contatos devolvidos pela RPC. Nao loga nada. */
export function montarLinhasContatos(contatos, canal, normalizarTelefone) {
  return (contatos || []).map((c) => {
    const telFmt = normalizarTelefone(c.telefone);
    return canal === "WHATSAPP"
      ? { "Nome do aluno": c.nome, Telefone: telFmt }
      : { "Nome do aluno": c.nome, "E-mail": (c.email || "").trim(), Telefone: telFmt || "" };
  });
}

/**
 * Gera o livro e dispara o download. Lanca erro classificado como "arquivo" se qualquer passo falhar.
 * `xlsx` e a biblioteca (injetada para teste); `escrever` faz o download (injetado para teste).
 */
export function gerarArquivoExportacao(xlsx, rel, escrever = (livro, nome) => xlsx.writeFile(livro, nome)) {
  try {
    if (!rel || !Array.isArray(rel.linhas) || rel.linhas.length === 0) {
      throw new Error("sem linhas");
    }
    const planilha = xlsx.utils.json_to_sheet(rel.linhas);
    const livro = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(livro, planilha, "Ação Massiva");
    escrever(livro, rel.nomeArquivo);
    return { ok: true, linhas: rel.linhas.length };
  } catch (e) {
    throw Object.assign(new Error("arquivo"), { etapaFalha: "arquivo", original: e?.name ?? "Erro" });
  }
}
