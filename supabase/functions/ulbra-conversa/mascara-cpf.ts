// Máscara de CPF em TEXTO LIVRE, no servidor (ulbra-conversa), antes de devolver ao navegador.
// MESMOS critérios da interface (src/utils/mascararCpf.js, mascararCpfEmTexto). O teste
// mascara-cpf.test.ts compara as duas implementações com os mesmos casos.
//  - formatado (000.000.000-00): mascara sempre, mantém os dois últimos dígitos;
//  - só dígitos (11): mascara só se os verificadores batem (telefone de 11 dígitos não é apagado).
// O resto do texto não muda.

function digitosVerificadoresValidos(d: string): boolean {
  if (/^(\d)\1{10}$/.test(d)) return false;
  const calc = (base: string, pesoInicial: number): number => {
    let soma = 0;
    for (let i = 0; i < base.length; i++) soma += Number(base[i]) * (pesoInicial - i);
    const r = (soma * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return calc(d.slice(0, 9), 10) === Number(d[9]) && calc(d.slice(0, 10), 11) === Number(d[10]);
}

export function mascararCpfEmTexto(texto: unknown): string {
  const s = String(texto ?? "");
  return s
    .replace(/\b\d{3}\.\d{3}\.\d{3}-(\d{2})\b/g, (_m, fim: string) => `***.***.***-${fim}`)
    .replace(/(?<![\d.])\d{11}(?![\d.])/g, (m: string) => (digitosVerificadoresValidos(m) ? `***.***.***-${m.slice(-2)}` : m));
}
