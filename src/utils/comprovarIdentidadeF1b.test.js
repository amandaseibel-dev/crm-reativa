import { describe, it, expect } from "vitest";
import { comprovarIdentidadeF1b as prova } from "./comprovarIdentidadeF1b";
const pagamento = { id: "p1", aluno_id: "a1", matricula: "2026002333" };
const aluno = { id: "a1", cpf: "123.456.789-09" };
const primeContratos = [{ registration: "2026002333", cpf: "12345678909" }];
const dados = { pagamento, aluno, primeContratos };
describe("F1.b: prova independente de identidade", () => {
  it("matricula Santander e CPF Prime iguais aos do CRM comprovam", () => {
    expect(prova(dados)).toEqual({ comprovada: true, motivo: "REGISTRATION_CPF_UNICOS" });
  });
  it("nome ou aluno_id sozinho nao comprovam", () => {
    expect(prova({ ...dados, pagamento: { id: "p1", aluno_id: "a1" } }).comprovada).toBe(false);
  });
  it("matricula CRM nao e registration", () => {
    expect(prova({ ...dados, pagamento: { ...pagamento, matricula: "180" } }).comprovada).toBe(false);
  });
  it("CPFs diferentes para a mesma matricula impedem vinculo", () => {
    expect(prova({ ...dados, primeContratos: [...primeContratos, { registration: "2026002333", cpf: "99999999999" }] }).motivo).toBe("CPF_PRIME_AMBIGUO");
  });
  it("CPF no arquivo divergente bloqueia", () => {
    expect(prova({ ...dados, pagamento: { ...pagamento, cpf: "99999999999" } }).motivo).toBe("CPF_PAGAMENTO_DIVERGENTE");
  });
  it("CPF Prime divergente bloqueia", () => {
    expect(prova({ ...dados, aluno: { ...aluno, cpf: "99999999999" } }).motivo).toBe("CPF_DIVERGENTE");
  });
  it("matricula com letras nao pode virar identificador valido removendo caracteres", () => {
    expect(prova({ ...dados, pagamento: { ...pagamento, matricula: "abc2026002333" } }).comprovada).toBe(false);
  });
  it("sem aluno identificado bloqueia", () => {
    expect(prova({ ...dados, pagamento: { ...pagamento, aluno_id: null } }).comprovada).toBe(false);
  });
});
