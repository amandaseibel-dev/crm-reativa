// Valor seguro para .ilike() do PostgREST em comparações de e-mail.
// PostgREST trata * como curinga em ilike (não há escape confiável para ele): e-mail com * é RECUSADO
// (devolve null) e o chamador nega o acesso. \ % _ são escapados, então um e-mail legítimo com _ casa exatamente.
export function emailParaIlike(email: string): string | null {
  if (email.includes("*")) return null;
  return email.replace(/[\\%_]/g, (c) => "\\" + c);
}
