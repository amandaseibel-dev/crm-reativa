// Formatadores da fila assistida de vinculo de mensalidades (sem componente: mantem o fast refresh feliz).
export function dataBR(v) { if (!v) return "-"; const p = String(v).slice(0, 10).split("-"); return p.length === 3 ? `${p[2]}/${p[1]}/${p[0]}` : String(v); }
// CPF parcialmente mascarado: mantem 3 primeiros e 2 ultimos digitos.
export function cpfMascarado(cpf) {
  const d = String(cpf || "").replace(/\D/g, "");
  if (d.length < 5) return "sem CPF";
  return `${d.slice(0, 3)}.***.***-${d.slice(-2)}`;
}
