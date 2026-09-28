// Regras puras do Preventivo. O teste mais importante deste arquivo é o
// último: a normalização de celular existe em DOIS lugares (aqui e na
// migration 20260928143843) e as duas precisam responder igual, senão a prévia
// promete um público e a exportação entrega outro.
import { describe, it, expect } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  normalizarCelular, emailValido, sugerirMapeamento, camposObrigatoriosFaltando,
  paraNumero, paraDataISO, linhaParaRegistro, csv, COLUNAS_WHATSAPP,
  frescorDaAtualizacao, celularesDoCampo, emailsDoCampo, lerCsv, decodificar,
} from "./preventivo";

const AQUI = dirname(fileURLToPath(import.meta.url));
const ler = (p) => readFileSync(resolve(AQUI, "..", "..", p), "utf8");

// Os mesmos casos rodam nos dois lados. Trocar um número aqui obriga a trocar
// do outro lado também — é esse o ponto.
const CASOS_CELULAR = [
  ["(51) 99999-0001", "5551999990001"],
  ["51999990001", "5551999990001"],
  ["5551999990001", "5551999990001"],
  ["+55 51 98888-7777", "5551988887777"],
  ["051999990001", "5551999990001"],
  ["(51) 3333-4444", null],   // fixo não vira celular
  ["999", null],              // incompleto não é completado
  ["", null],
  [null, null],
  ["5133334444", null],       // 10 dígitos: fixo
  ["01999990001", null],      // DDD 01 não existe
];

describe("celular", () => {
  it.each(CASOS_CELULAR)("normaliza %s", (entrada, esperado) => {
    expect(normalizarCelular(entrada)).toBe(esperado);
  });

  it("a tela e o banco respondem a mesma coisa", async () => {
    const db = new PGlite();
    await db.exec(`
      create role anon; create role authenticated; create role service_role;
      create schema auth;
      create function auth.jwt() returns jsonb language sql stable as $$ select '{}'::jsonb $$;
      create table public.usuarios (email text, ativo boolean);
    `);
    await db.exec(ler("supabase/migrations/20260928143743_preventivo_estrutura.sql"));
    await db.exec(ler("supabase/migrations/20260928143843_preventivo_importacao.sql"));
    for (const [entrada, esperado] of CASOS_CELULAR) {
      const r = await db.query(`select public.preventivo_normalizar_celular($1) as v`, [entrada]);
      expect([entrada, r.rows[0].v]).toEqual([entrada, esperado]);
    }
  }, 30000);
});

describe("e-mail", () => {
  it("aceita o que é endereço e recusa o que não é", () => {
    expect(emailValido("fulana@exemplo.com")).toBe(true);
    expect(emailValido("fulana@exemplo.com.br")).toBe(true);
    expect(emailValido("fulana(arroba)exemplo")).toBe(false);
    expect(emailValido("fulana@exemplo")).toBe(false);
    expect(emailValido("")).toBe(false);
  });
});

// O cabeçalho REAL do relatório de inadimplência da ULBRA, exatamente como
// veio no arquivo de 28/09/2026. Se a ULBRA mudar o relatório, é aqui que
// aparece primeiro.
const CABECALHO_REAL = [
  "Código", "Nome do Aluno", "Curso", "Dt Vcto ", "Vcto Origem ", "Responsável",
  "E-mail", "Telefone", "Endereço", "Saldo Original", "Saldo Atualizado",
  "Estabelecimento", "Processo", "Escola", "Situação Acadêmica", "Tipo de Boleto",
];

describe("mapeamento de colunas", () => {
  it("reconhece o relatório REAL da ULBRA", () => {
    const m = sugerirMapeamento(CABECALHO_REAL);
    expect(CABECALHO_REAL[m.matricula]).toBe("Código");
    expect(CABECALHO_REAL[m.aluno_nome]).toBe("Nome do Aluno");
    expect(CABECALHO_REAL[m.vencimento].trim()).toBe("Dt Vcto");
    expect(CABECALHO_REAL[m.vencimento_origem].trim()).toBe("Vcto Origem");
    expect(CABECALHO_REAL[m.saldo]).toBe("Saldo Original");
    expect(CABECALHO_REAL[m.saldo_atualizado]).toBe("Saldo Atualizado");
    expect(camposObrigatoriosFaltando(m)).toEqual([]);
  });

  it("'Tipo de Boleto' NÃO é o identificador do título", () => {
    // No relatório real essa coluna vale "Mensalidade" ou "Matrícula".
    // Casá-la com o documento faria a carteira inteira entrar errada.
    const m = sugerirMapeamento(CABECALHO_REAL);
    expect(m.documento).toBeUndefined();
  });

  it("quando o arquivo TEM número de boleto, ele é usado", () => {
    const m = sugerirMapeamento(["Matrícula", "Nome", "Nosso Número", "Vencimento", "Saldo"]);
    expect(m.documento).toBe(2);
  });

  it("reconhece cabeçalho sem depender de acento nem de caixa", () => {
    const m = sugerirMapeamento([
      "Matrícula", "NOME DO ALUNO", "Boleto", "Data de Vencimento",
      "Valor", "Saldo em Aberto", "Situação", "Celular", "E-mail",
    ]);
    expect(m.matricula).toBe(0);
    expect(m.aluno_nome).toBe(1);
    expect(m.documento).toBe(2);
    expect(m.vencimento).toBe(3);
    expect(m.valor).toBe(4);
    expect(m.saldo).toBe(5);
    expect(m.situacao).toBe(6);
    expect(m.celular).toBe(7);
    expect(m.email).toBe(8);
  });

  it("nunca usa a mesma coluna para dois campos", () => {
    const m = sugerirMapeamento(["Documento", "Documento"]);
    const usados = Object.values(m);
    expect(new Set(usados).size).toBe(usados.length);
  });

  it("um arquivo só com nome e telefone não serve de carteira financeira", () => {
    // é exatamente o arquivo de contatos que já existe: não tem título.
    const m = sugerirMapeamento(["Nome do Aluno", "Telefone"]);
    const faltam = camposObrigatoriosFaltando(m).join(" | ");
    expect(faltam).toMatch(/Matrícula/);
    expect(faltam).toMatch(/Vencimento atual/);
    expect(faltam).toMatch(/Saldo em aberto/);
  });
});

describe("conversões", () => {
  it("lê valor em português e em inglês", () => {
    expect(paraNumero("1.234,56")).toBe(1234.56);
    expect(paraNumero("R$ 500,00")).toBe(500);
    expect(paraNumero("500.00")).toBe(500);
    expect(paraNumero(500)).toBe(500);
    expect(paraNumero("")).toBe(null);
    expect(paraNumero("abc")).toBe(null);
  });

  it("lê data em dd/mm/aaaa, aaaa-mm-dd e Date da planilha", () => {
    expect(paraDataISO("25/09/2026")).toBe("2026-09-25");
    expect(paraDataISO("2026-09-25")).toBe("2026-09-25");
    expect(paraDataISO(new Date(2026, 8, 25))).toBe("2026-09-25");
    expect(paraDataISO("sem data")).toBe(null);
  });

  it("linha vira registro com o valor já em ponto e a data em ISO", () => {
    const mapa = { matricula: 0, aluno_nome: 1, documento: 2, vencimento: 3, valor: 4 };
    const r = linhaParaRegistro(["2026000001", " Fulana ", "9000001", "25/09/2026", "R$ 1.234,56"], mapa);
    expect(r).toMatchObject({
      matricula: "2026000001", aluno_nome: "Fulana", documento: "9000001",
      vencimento: "2026-09-25", valor: "1234.56", saldo: null,
    });
  });
});

describe("arquivo para a mensageria", () => {
  it("escapa aspas e ponto e vírgula sem corromper a linha", () => {
    const saida = csv(
      [{ aluno: 'Fulana "da" Silva; Jr', contato: "5551999990001", matricula: "1", vencimento: "2026-09-25", saldo_informado: 500 }],
      COLUNAS_WHATSAPP);
    const linhas = saida.split("\r\n");
    expect(linhas[0]).toBe("nome;telefone;matricula;vencimento;valor");
    expect(linhas[1]).toBe('"Fulana ""da"" Silva; Jr";5551999990001;1;2026-09-25;500');
  });

  it("o valor exportado é o saldo INFORMADO pelo arquivo, não um número da API", () => {
    // O que a mensageria manda para o aluno é o que a ULBRA disse que ele
    // deve. O netAmount da API não é saldo e não pode ir numa mensagem.
    const linhas = csv([
      { aluno: "A", contato: "1", matricula: "1", vencimento: "2026-09-25", saldo_informado: 500, valor_fonte: 200 },
    ], COLUNAS_WHATSAPP).split("\r\n");
    expect(linhas[1].endsWith(";500")).toBe(true);
  });
});

describe("frescor da atualização", () => {
  const agora = new Date("2026-09-28T12:00:00Z");

  it("carteira nunca sincronizada não é apresentada como conferida", () => {
    expect(frescorDaAtualizacao({}, agora).nivel).toBe("nunca");
    expect(frescorDaAtualizacao({ ultima_tentativa: { status: "FALHOU" } }, agora).nivel).toBe("nunca");
  });

  it("mais de 36 horas é desatualizado, e a tela diz isso", () => {
    const r = frescorDaAtualizacao({ ultima_completa: { concluido_em: "2026-09-26T12:00:00Z" } }, agora);
    expect(r.nivel).toBe("desatualizado");
    expect(r.texto).toMatch(/pode não refletir pagamentos recentes/);
  });

  it("dentro da janela é atual", () => {
    expect(frescorDaAtualizacao({ ultima_completa: { concluido_em: "2026-09-28T06:00:00Z" } }, agora).nivel).toBe("atual");
  });
});

describe("leitura do CSV real", () => {
  it("não corta a linha no ponto e vírgula que está DENTRO das aspas", () => {
    // A coluna E-mail do relatório real traz dois endereços separados por `;`.
    // Ler com split(";") jogava 2.742 das 3.495 linhas fora.
    const texto = '"Código";"E-mail";"Saldo"\r\n"2024007267";"a@x.com;b@rede.ulbra.br";"831,66"\r\n';
    const linhas = lerCsv(texto);
    expect(linhas[0]).toEqual(["Código", "E-mail", "Saldo"]);
    expect(linhas[1]).toEqual(["2024007267", "a@x.com;b@rede.ulbra.br", "831,66"]);
  });

  it("aspas duplas escapadas viram uma aspa só", () => {
    expect(lerCsv('"a""b";"c"')[0]).toEqual(['a"b', "c"]);
  });

  it("linha em branco não vira registro", () => {
    expect(lerCsv("a;b\r\n\r\nc;d\r\n").length).toBe(2);
  });

  it("o arquivo real vem em LATIN-1 e é decodificado sem estragar acento", () => {
    // "Situação" em latin1
    const latin1 = new Uint8Array([0x53, 0x69, 0x74, 0x75, 0x61, 0xe7, 0xe3, 0x6f]);
    expect(decodificar(latin1.buffer)).toBe("Situação");
    const utf8 = new TextEncoder().encode("Situação");
    expect(decodificar(utf8.buffer)).toBe("Situação");
  });
});

describe("contatos multivalorados do relatório real", () => {
  it("lê todos os celulares do campo, sem escolher nenhum", () => {
    const campo = "(51) 99547-2585, CEL:(51) 991859609, CEL:5192568106, RES:51991859609";
    expect(celularesDoCampo(campo)).toEqual(["5551991859609", "5551995472585"]);
  });

  it("um celular repetido em formatos diferentes conta como um só", () => {
    expect(celularesDoCampo("(51) 98054-2650, CEL:51980542650, RES:34041289"))
      .toEqual(["5551980542650"]);
  });

  it("campo só com fixo não devolve celular nenhum", () => {
    expect(celularesDoCampo("(51) 3333-4444, RES:5133334444")).toEqual([]);
  });

  it("lê todos os e-mails do campo, sem escolher nenhum", () => {
    expect(emailsDoCampo("adalberons10@gmail.com;adalberon.silva@rede.ulbra.br"))
      .toEqual(["adalberon.silva@rede.ulbra.br", "adalberons10@gmail.com"]);
  });

  it("o mesmo e-mail em caixas diferentes conta como um só", () => {
    expect(emailsDoCampo("Fulana@Exemplo.com fulana@exemplo.com")).toEqual(["fulana@exemplo.com"]);
  });
});
