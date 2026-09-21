// Alerta D-2 de parcela de acordo (fonte: RPC acordo_alertas_do_operador, tabela acordo_alertas_parcela).
// Funcoes PURAS, testaveis sem login. O alerta e so leitura: nunca altera aluno, caso, parcela, acordo ou responsavel.

export function normalizarAlertas(data) {
  return Array.isArray(data) ? data.filter((a) => a && a.aluno_id && a.parcela_id) : [];
}

// vence hoje | vence amanha | em N dias | vencida (nao deveria aparecer: a rotina resolve como VENCIDA)
export function rotuloDiasRestantes(dias) {
  const n = Number(dias);
  if (!Number.isFinite(n)) return "";
  if (n === 0) return "vence hoje";
  if (n === 1) return "vence amanhã";
  if (n > 1) return `vence em ${n} dias`;
  return "vencida";
}

export function formatarDataBR(iso) {
  const s = String(iso ?? "").slice(0, 10);
  const p = s.split("-");
  return p.length === 3 ? `${p[2]}/${p[1]}/${p[0]}` : s;
}

export function formatarValorBRL(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "";
  return n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

// Mais urgente primeiro; empate por nome do aluno e numero do acordo. Nao muta a entrada.
export function ordenarAlertas(alertas) {
  return [...normalizarAlertas(alertas)].sort(
    (a, b) =>
      Number(a.dias_restantes) - Number(b.dias_restantes) ||
      String(a.aluno_nome || "").localeCompare(String(b.aluno_nome || ""), "pt-BR") ||
      Number(a.numero_acordo) - Number(b.numero_acordo) ||
      Number(a.numero_parcela) - Number(b.numero_parcela)
  );
}

export function chaveAlerta(a) {
  return `${a.acordo_id}|${a.parcela_id}`;
}

export function descricaoAlerta(a) {
  const ac = a.numero_acordo != null ? `Acordo #${a.numero_acordo}` : "Acordo";
  const pa = a.numero_parcela != null ? `parcela ${a.numero_parcela}` : "parcela";
  return `${ac} · ${pa}`;
}

// Alertas de um aluno (um por acordo+parcela; um aluno com dois acordos tem duas linhas).
export function alertasDoAluno(alertas, alunoId) {
  return normalizarAlertas(alertas).filter((a) => String(a.aluno_id) === String(alunoId));
}
