// F1.b: prova de identidade pela matricula do arquivo Santander -> Prime -> CPF -> aluno CRM.
// Recebe dados ja carregados de fontes autorizadas. Sem consultas, gravacoes ou PII no retorno.
const digitos = (v) => typeof v === "string" || typeof v === "number" ? String(v).replace(/\D/g, "") : "";
const unico = (rows) => rows.length === 1 ? rows[0] : null;
const bloqueio = (motivo) => ({ comprovada: false, motivo });

export function comprovarIdentidadeF1b({ pagamento, aluno, primeContratos = [] } = {}) {
  if (!pagamento?.id || !aluno?.id || String(pagamento.aluno_id ?? "") !== String(aluno.id)) {
    return bloqueio("ALUNO_NAO_CONFERIDO");
  }
  const matricula = digitos(pagamento.matricula);
  const cpfAluno = digitos(aluno.cpf);
  if (!matricula || !/^\d{11}$/.test(cpfAluno)) return bloqueio("CHAVE_DE_IDENTIDADE_AUSENTE");
  // Filtra TODAS as linhas da Prime para a matricula; CPF repetido entre contratos
  // e aceitavel; CPFs distintos para a mesma matricula nao sao.
  const coincidentes = primeContratos.filter(c => digitos(c.registration) === matricula);
  const cpfs = [...new Set(coincidentes.map(c => digitos(c.cpf)))];
  if (!coincidentes.length) return bloqueio("MATRICULA_SEM_REGISTRO_PRIME");
  if (cpfs.length !== 1 || !/^\d{11}$/.test(cpfs[0])) return bloqueio("CPF_PRIME_AMBIGUO");
  if (cpfs[0] !== cpfAluno) return bloqueio("CPF_DIVERGENTE");
  if (pagamento.cpf && digitos(pagamento.cpf) !== cpfAluno) return bloqueio("CPF_PAGAMENTO_DIVERGENTE");
  return { comprovada: true, motivo: "REGISTRATION_CPF_UNICOS" };
}
