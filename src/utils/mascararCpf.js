// CPF para exibir na tela: só os dois dígitos verificadores ficam visíveis.
//
// Em produção, `alunos.cpf_mascarado` guarda o CPF formatado SEM máscara
// (medido em 17/09/2026). O nome da coluna não é garantia de nada, então a
// máscara é aplicada aqui, na apresentação. O valor armazenado não muda.
//
// Aceita o CPF formatado, só dígitos ou já mascarado ("***.826.041-**"): nunca
// devolve mais do que os dois últimos dígitos, e só quando eles são dígitos.
export function mascararCpf(valor) {
  const s = String(valor ?? "").trim();
  if (!s) return "—";
  const fim = s.slice(-2);
  return `***.***.***-${/^\d{2}$/.test(fim) ? fim : "**"}`;
}
