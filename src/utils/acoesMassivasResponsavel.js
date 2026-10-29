// A sintaxe 'CASO:a|b;ACORDO:c' que a tela manda em p_operador_email é
// contrato com o banco — não é texto de tela nem nome de arquivo. Este módulo
// desmonta ela de volta.
//
// Ela existe porque acoes_massivas_previa tem 18 parâmetros escalares e monta o
// jsonb de filtros internamente: não há por onde passar array sem mudar a
// assinatura de quem dispara mensagem em massa. O código já usa o idioma de
// lista em texto ('2025|2026' em ano, unidade e situação acadêmica).

// A sintaxe 'CASO:a|b;ACORDO:c' é contrato com o banco, não texto de tela nem
// nome de arquivo. Estes dois desmontam ela de volta.
export function responsaveisDaSelecao(filtro) {
  const t = String(filtro ?? "");
  if (!/^CASO:/i.test(t)) return { caso: [], acordo: [] };
  const [parteCaso, parteAcordo = ""] = t.split(";");
  const lista = (x) => x.split(":").slice(1).join(":").split("|").filter(Boolean);
  return { caso: lista(parteCaso), acordo: /ACORDO:/i.test(parteAcordo) ? lista(parteAcordo) : [] };
}

// Pedaço de nome de arquivo: sem ':' nem '|', que são inválidos em alguns
// sistemas de arquivo. Um responsável vira o login; vários viram a contagem.
export function sufixoArquivoResponsavel(filtro) {
  const { caso } = responsaveisDaSelecao(filtro);
  if (caso.length === 0) return "";
  if (caso.length > 1) return `-${caso.length}responsaveis`;
  const um = caso[0];
  if (um === "SEM_RESPONSAVEL") return "-sem-responsavel";
  return um.includes("@") ? `-${um.split("@")[0]}` : `-${um.replace(/[^a-z0-9]+/gi, "")}`;
}

// Texto de tela a partir da sintaxe. Nunca mostra 'CASO:'/'ACORDO:' crus.
function nomeUm(email, nomeDoOperador) {
  return email === "SEM_RESPONSAVEL" ? "sem responsável / livres" : nomeDoOperador(email);
}
export function detalheSelecao(filtro, nomeDoOperador) {
  const { caso, acordo } = responsaveisDaSelecao(filtro);
  const junta = (l) =>
    l.length === 0 ? "" : l.length <= 2 ? l.map((e) => nomeUm(e, nomeDoOperador)).join(" e ")
                                        : `${l.length} responsáveis`;
  return {
    caso: caso.length ? junta(caso) : nomeDoOperador(filtro),
    acordo: junta(acordo),
  };
}
