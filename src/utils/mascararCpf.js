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

// CPF dentro de TEXTO LIVRE (ex.: prévia da mensagem). Só mascara o que parece CPF:
//  - formatado (000.000.000-00), com ou sem verificadores válidos: máscara sempre;
//  - só dígitos (11): máscara só se os dígitos verificadores batem, para não apagar
//    telefones e outros números longos. O resto do texto não muda.
function digitosVerificadoresValidos(d) {
  if (/^(\d)\1{10}$/.test(d)) return false;
  const calc = (base, pesoInicial) => {
    let soma = 0;
    for (let i = 0; i < base.length; i++) soma += Number(base[i]) * (pesoInicial - i);
    const r = (soma * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return calc(d.slice(0, 9), 10) === Number(d[9]) && calc(d.slice(0, 10), 11) === Number(d[10]);
}

export function mascararCpfEmTexto(texto) {
  const s = String(texto ?? "");
  return s
    .replace(/\b\d{3}\.\d{3}\.\d{3}-(\d{2})\b/g, (_, fim) => `***.***.***-${fim}`)
    .replace(/(?<![\d.])\d{11}(?![\d.])/g, (m) => (digitosVerificadoresValidos(m) ? `***.***.***-${m.slice(-2)}` : m));
}
