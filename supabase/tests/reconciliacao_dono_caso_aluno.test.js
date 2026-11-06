// RECONCILIACAO DONO/ACIONAMENTO ENTRE FICHA E CASO.
//
// O que este arquivo prova, em PostgreSQL real (PGlite), sobre a migration
// 20261019210000_reconciliacao_dono_caso_aluno.sql:
//
//   * APLICAR A MIGRATION NAO MUDA COMPORTAMENTO. O gatilho nasce desabilitado,
//     entao um caso criado depois de aplicar continua nascendo com
//     operador_email e data_ultimo_acionamento NULL, exatamente como hoje. Esta
//     e a garantia de regressao que autoriza aplicar sem autorizar a mudanca de
//     distribuicao;
//   * LIGADO, o gatilho herda a data (com o cast de fuso America/Sao_Paulo, que
//     e o que o campo `date` do caso exige) e o dono -- e so quando vem NULL;
//   * a EXCECAO DA BANCADA e respeitada: dono gerencia / administrativo /
//     supervisor NAO e herdado pelo caso, e a reconciliacao o entrega com
//     dono_e_bancada = true para decisao humana;
//   * herdar TIRA o caso da FILA LIVRE (pool_da_fila_livre), que e o pool de
//     onde seis rotinas de distribuicao pescam -- inclusive o nivelamento das
//     09:20. Era isso que deixava a ficha com a Olga e o caso disponivel para
//     qualquer um ao mesmo tempo;
//   * NENHUM RETORNO ARTIFICIAL: data_retorno do caso e da ficha ficam como
//     estavam, e a fidelizacao vigente nao e nem renovada nem perdida;
//   * a UNIAO NAO CONTA EM DOBRO: um aluno que cai nas quatro classes aparece
//     UMA vez, com as quatro etiquetas;
//   * PORTAO: quem nao e gestao leva 42501 nas duas funcoes de leitura;
//   * cpf_digito_valido separa CPF corrompido por deslocamento de digito
//     (o padrao real da ficha duplicada) de CPF valido.
//
// Dados sao FICTICIOS. O CPF usado e o de teste publico 111.444.777-35; o
// "corrompido" e ele deslocado um digito, que e a forma do defeito observado.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { montar, como, comoPapel, voltarDono, q1, qn, GESTAO, FERNANDA, ADM, OLGA, LUANA } from "./fixtures/carteira_geral/bancada.js";

const AQUI = dirname(fileURLToPath(import.meta.url));
const RAIZ = resolve(AQUI, "..", "..");
const MIGRATION = "supabase/migrations/20261019210000_reconciliacao_dono_caso_aluno.sql";
const ROLLBACK = "supabase/rollbacks/20261019210000_reconciliacao_dono_caso_aluno.rollback.sql";
const ler = (p) => readFileSync(resolve(RAIZ, p), "utf8");

vi.setConfig({ testTimeout: 180000, hookTimeout: 180000 });

const CPF_VALIDO = "11144477735";
// mesmo defeito da ficha duplicada real: perde o ultimo digito, ganha um zero
// a esquerda. Continua com 11 digitos, entao so o digito verificador acusa.
const CPF_DESLOCADO = `0${CPF_VALIDO.slice(0, 10)}`;

// A bancada compartilhada da Carteira Geral nao modela as colunas de saldo,
// matricula, telefone, e-mail e nome_normalizado, nem as duas funcoes que esta
// migration CHAMA. O complemento abaixo so ACRESCENTA o que existe em producao
// -- nao altera nada do esqueleto, para nao mudar o que os outros testes provam.
const COMPLEMENTO = `
alter table public.alunos add column if not exists nome_normalizado text;
alter table public.alunos add column if not exists saldo_total numeric default 0;
alter table public.alunos add column if not exists saldo_vencido numeric default 0;
alter table public.alunos add column if not exists matricula text;
alter table public.alunos add column if not exists telefone text;
alter table public.alunos add column if not exists email text;

-- em producao e trigger; aqui basta o valor estar coerente ao inserir
create or replace function public._norm_nome() returns trigger language plpgsql as $$
begin
  new.nome_normalizado := upper(btrim(coalesce(new.nome, '')));
  return new;
end $$;
drop trigger if exists trg_norm_nome on public.alunos;
create trigger trg_norm_nome before insert or update on public.alunos
  for each row execute function public._norm_nome();

-- copias fieis dos corpos de producao em 19/10/2026
create or replace function public.caso_dentro_prazo_fidelizacao(p_data_ultimo_acionamento date)
 returns boolean language sql stable set search_path to 'public' as $$
  select p_data_ultimo_acionamento is not null
     and p_data_ultimo_acionamento + 10 >= current_date;
$$;

create or replace function public.usuario_e_gestao() returns boolean
 language sql stable set search_path to 'public' as $$
  select lower(coalesce(auth.jwt()->>'email','')) = lower('${GESTAO}');
$$;
`;

// insere um aluno direto, sem o pacote do semear() (que sempre cria caso e
// acordo): aqui o ponto e justamente controlar o nascimento do caso.
async function ficha(db, { nome, dono, dua = null, saldo = 1000, cpf = CPF_VALIDO, matricula = "12340", retorno = null }) {
  return (await q1(db,
    `insert into public.alunos
       (nome, cpf, matricula, responsavel_atual_email, responsavel_atual_nome,
        data_ultimo_acionamento, saldo_total, saldo_vencido, data_retorno, telefone)
     values ($1,$2,$3,$4,$4,$5,$6,$6,$7,'5551999999999') returning id`,
    [nome, cpf, matricula, dono, dua, saldo, retorno])).id;
}

const nasceCaso = (db, aluno, extra = {}) => q1(db,
  `insert into public.casos (aluno_id, nome, operador_email, data_ultimo_acionamento, data_retorno)
   values ($1,$2,$3,$4,$5) returning id, operador_email, operador_nome, data_ultimo_acionamento, data_retorno`,
  [aluno, "ficha", extra.operador ?? null, extra.dua ?? null, extra.retorno ?? null]);

const ligar = (db) => db.exec("alter table public.casos enable trigger trg_caso_herda_do_aluno");

// PGlite devolve `date` como Date do JS. Comparar o dia exige formatar, senao a
// assercao vira "Wed Oct 14 2026 ..." e passa/falha por acidente.
const dia = (v) => (v == null ? null : new Date(v).toISOString().slice(0, 10));

describe("reconciliacao dono/acionamento entre ficha e caso", () => {
  let db;

  beforeEach(async () => {
    db = await montar();
    await db.exec(COMPLEMENTO);
    await db.exec(ler(MIGRATION));
    // Em producao cobranca03 (Olga) esta com usuarios.ativo = false desde que
    // saiu da equipe -- e e dela que sao os 8 alunos com saldo medidos. A
    // bancada compartilhada a mantem ativa para os testes da Carteira Geral,
    // entao aqui ela e desligada, que e o estado real.
    await db.query("update public.usuarios set ativo = false where email = $1", [OLGA]);
    await como(db, GESTAO);
  });

  afterEach(async () => { await db?.close(); });

  describe("a migration e inerte ao ser aplicada", () => {
    it("o gatilho existe e esta DESABILITADO", async () => {
      const t = await q1(db,
        "select tgenabled from pg_trigger where tgname = 'trg_caso_herda_do_aluno'");
      // 'D' = disabled. 'O' seria habilitado no modo de origem.
      expect(t.tgenabled).toBe("D");
    });

    it("caso novo continua nascendo sem dono e sem acionamento", async () => {
      const aluno = await ficha(db, { nome: "Inerte", dono: LUANA, dua: "2026-10-15T12:00:00Z" });
      const caso = await nasceCaso(db, aluno);
      expect(caso.operador_email).toBeNull();
      expect(caso.data_ultimo_acionamento).toBeNull();
    });

    it("e o caso nasce na FILA LIVRE, como hoje", async () => {
      const aluno = await ficha(db, { nome: "Inerte2", dono: LUANA, dua: "2026-10-15T12:00:00Z" });
      const caso = await nasceCaso(db, aluno);
      const livre = await qn(db, "select * from public.pool_da_fila_livre() where pool_da_fila_livre = $1", [caso.id]);
      expect(livre).toHaveLength(1);
    });
  });

  describe("com o gatilho ligado", () => {
    beforeEach(() => ligar(db));

    it("herda a data da ficha com o fuso de Brasilia", async () => {
      // 2026-10-15T01:00Z em America/Sao_Paulo ainda e 14/10. O cast errado
      // (sem fuso) gravaria 15/10 e daria 1 dia de fidelizacao de brinde.
      const aluno = await ficha(db, { nome: "Fuso", dono: LUANA, dua: "2026-10-15T01:00:00Z" });
      const caso = await nasceCaso(db, aluno);
      expect(dia(caso.data_ultimo_acionamento)).toBe("2026-10-14");
    });

    it("herda o dono quando o responsavel e operador", async () => {
      const aluno = await ficha(db, { nome: "Dono", dono: LUANA, dua: "2026-10-10T12:00:00Z" });
      const caso = await nasceCaso(db, aluno);
      expect(caso.operador_email).toBe(LUANA);
    });

    it("tira o caso da fila livre -- fecha o furo dos 4 vivos da Olga", async () => {
      const aluno = await ficha(db, { nome: "Olga vivo", dono: OLGA, dua: "2026-10-10T12:00:00Z" });
      const caso = await nasceCaso(db, aluno);
      // dono INATIVO e herdado de proposito: trocar dono e trabalho do
      // carteira_geral_mover, com previa. O que nao pode e ficha com dono e
      // caso na fila livre ao mesmo tempo.
      expect(caso.operador_email).toBe(OLGA);
      const livre = await qn(db, "select * from public.pool_da_fila_livre() where pool_da_fila_livre = $1", [caso.id]);
      expect(livre).toHaveLength(0);
    });

    it("NAO sobrescreve o que o insert trouxe explicitamente", async () => {
      const aluno = await ficha(db, { nome: "Explicito", dono: LUANA, dua: "2026-10-10T12:00:00Z" });
      const caso = await nasceCaso(db, aluno, { operador: FERNANDA, dua: "2026-01-01" });
      expect(caso.operador_email).toBe(FERNANDA);
      expect(dia(caso.data_ultimo_acionamento)).toBe("2026-01-01");
    });

    it("NAO herda dono de bancada (gerencia, ADM, supervisao)", async () => {
      for (const bancada of [GESTAO, ADM, FERNANDA]) {
        const aluno = await ficha(db, { nome: `Bancada ${bancada}`, dono: bancada, dua: "2026-10-10T12:00:00Z" });
        const caso = await nasceCaso(db, aluno);
        expect(caso.operador_email).toBeNull();
        // a data e herdada mesmo assim: data nao e atribuicao de trabalho
        expect(caso.data_ultimo_acionamento).not.toBeNull();
      }
    });

    it("NAO cria retorno artificial, nem no caso nem na ficha", async () => {
      const aluno = await ficha(db, { nome: "Sem retorno", dono: LUANA, dua: "2026-10-10T12:00:00Z" });
      const caso = await nasceCaso(db, aluno);
      expect(caso.data_retorno).toBeNull();
      const a = await q1(db, "select data_retorno, retorno_origem from public.alunos where id = $1", [aluno]);
      expect(a.data_retorno).toBeNull();
      expect(a.retorno_origem).toBeNull();
    });

    it("preserva retorno e fidelizacao que a ficha ja tinha", async () => {
      const aluno = await ficha(db, { nome: "Fidelizado", dono: LUANA, dua: "2026-10-18T12:00:00Z", retorno: "2026-10-25" });
      const caso = await nasceCaso(db, aluno);
      const a = await q1(db, "select data_retorno from public.alunos where id = $1", [aluno]);
      expect(dia(a.data_retorno)).toBe("2026-10-25");
      const prazo = await q1(db,
        "select public.caso_dentro_prazo_fidelizacao(data_ultimo_acionamento) as viva from public.casos where id = $1",
        [caso.id]);
      expect(prazo.viva).toBe(true);
    });

    it("aluno sem ficha correspondente nao quebra o insert", async () => {
      const caso = await q1(db,
        "insert into public.casos (aluno_id, nome) values (gen_random_uuid(), 'orfao') returning id, operador_email",
        []);
      expect(caso.id).toBeTruthy();
      expect(caso.operador_email).toBeNull();
    });
  });

  describe("diagnostico reconciliacao_dono_caso_aluno", () => {
    it("conta o aluno UMA vez quando ele cai em varias classes", async () => {
      // Olga (operador inativo) + caso sem operador + caso sem acionamento +
      // ficha duplicada com CPF deslocado: as 4 classes no mesmo aluno.
      const aluno = await ficha(db, { nome: "Quadrupla", dono: OLGA, dua: "2026-09-30T12:00:00Z", saldo: 4291.04 });
      await ficha(db, { nome: "Quadrupla", dono: null, dua: null, saldo: 0, cpf: CPF_DESLOCADO });
      await nasceCaso(db, aluno); // gatilho desligado aqui: nasce NULL/NULL

      const linhas = await qn(db, "select * from public.reconciliacao_dono_caso_aluno()");
      const dela = linhas.filter((l) => l.aluno_id === aluno);
      expect(dela).toHaveLength(1);
      expect(dela[0].classes.sort()).toEqual([
        "CASO_SEM_ACIONAMENTO", "CASO_SEM_OPERADOR", "DONO_INATIVO", "FICHA_DUPLICADA",
      ]);
      expect(Number(dela[0].saldo_total)).toBeCloseTo(4291.04, 2);
    });

    it("marca dono_e_bancada sem marcar dono_inativo", async () => {
      const aluno = await ficha(db, { nome: "Da bancada", dono: ADM, dua: "2026-10-10T12:00:00Z" });
      await nasceCaso(db, aluno);
      const l = (await qn(db, "select * from public.reconciliacao_dono_caso_aluno()")).find((x) => x.aluno_id === aluno);
      expect(l.dono_e_bancada).toBe(true);
      expect(l.dono_inativo).toBe(false);
      expect(l.classes).toContain("CASO_SEM_OPERADOR");
    });

    it("respeita apenas_com_saldo e o filtro por classe", async () => {
      await ficha(db, { nome: "Zerado", dono: OLGA, dua: "2026-10-10T12:00:00Z", saldo: 0 });
      const comSaldo = await qn(db, "select * from public.reconciliacao_dono_caso_aluno()");
      expect(comSaldo.find((l) => l.nome === "Zerado")).toBeUndefined();

      const todos = await qn(db,
        `select * from public.reconciliacao_dono_caso_aluno('{"apenas_com_saldo": false}'::jsonb)`);
      expect(todos.find((l) => l.nome === "Zerado")).toBeTruthy();

      const so = await qn(db,
        `select * from public.reconciliacao_dono_caso_aluno('{"apenas_com_saldo": false, "classe": "DONO_INATIVO"}'::jsonb)`);
      expect(so.every((l) => l.classes.includes("DONO_INATIVO"))).toBe(true);
    });

    it("nao devolve aluno sem divergencia nenhuma", async () => {
      await ligar(db);
      const aluno = await ficha(db, { nome: "Alinhado", dono: LUANA, dua: "2026-10-10T12:00:00Z" });
      await nasceCaso(db, aluno);
      const l = (await qn(db, "select * from public.reconciliacao_dono_caso_aluno()")).find((x) => x.aluno_id === aluno);
      expect(l).toBeUndefined();
    });

    it("esconde caso encerrado por padrao e mostra sob pedido", async () => {
      const aluno = await ficha(db, { nome: "Encerrado", dono: OLGA, dua: "2026-10-10T12:00:00Z" });
      await nasceCaso(db, aluno);
      await db.query("update public.casos set encerrado_operacional = true where aluno_id = $1", [aluno]);
      const padrao = await qn(db, "select * from public.reconciliacao_dono_caso_aluno()");
      expect(padrao.find((l) => l.aluno_id === aluno)).toBeUndefined();
      const comEncerrados = await qn(db,
        `select * from public.reconciliacao_dono_caso_aluno('{"incluir_encerrados": true}'::jsonb)`);
      expect(comEncerrados.find((l) => l.aluno_id === aluno)).toBeTruthy();
    });
  });

  describe("fila de revisao de fichas duplicadas", () => {
    it("entrega o grupo com a evidencia, uma linha por ficha", async () => {
      const viva = await ficha(db, { nome: "Dupla Ficha", dono: OLGA, dua: "2026-10-10T12:00:00Z", saldo: 500 });
      await ficha(db, { nome: "Dupla Ficha", dono: null, saldo: 0, cpf: CPF_DESLOCADO });

      const linhas = await qn(db, "select * from public.fichas_duplicadas_revisao()");
      expect(linhas).toHaveLength(2);
      expect(linhas.every((l) => l.mesma_matricula_no_grupo)).toBe(true);
      expect(linhas.every((l) => l.mesmo_telefone_no_grupo)).toBe(true);
      expect(linhas.find((l) => l.aluno_id === viva).cpf_valido).toBe(true);
      expect(linhas.find((l) => l.cpf === CPF_DESLOCADO).cpf_valido).toBe(false);
    });

    it("nao chama homonimo de duplicado quando os dois CPFs sao validos", async () => {
      await ficha(db, { nome: "Homonimo", dono: LUANA, saldo: 100, cpf: CPF_VALIDO });
      await ficha(db, { nome: "Homonimo", dono: LUANA, saldo: 100, cpf: "52998224725" });
      const linhas = await qn(db, "select * from public.fichas_duplicadas_revisao()");
      expect(linhas.filter((l) => l.grupo === "HOMONIMO")).toHaveLength(0);
    });

    it("NAO escreve: a funcao e STABLE e o Postgres recusa DML nela", async () => {
      const v = await q1(db,
        `select p.provolatile from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = 'fichas_duplicadas_revisao'`);
      expect(v.provolatile).toBe("s");
      const r = await q1(db,
        `select p.provolatile from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = 'reconciliacao_dono_caso_aluno'`);
      expect(r.provolatile).toBe("s");
    });
  });

  describe("digito verificador do CPF", () => {
    it("aprova valido, reprova o deslocado, o repetido e o curto", async () => {
      const r = await q1(db, `select
          public.cpf_digito_valido($1) as valido,
          public.cpf_digito_valido($2) as deslocado,
          public.cpf_digito_valido('00000000000') as repetido,
          public.cpf_digito_valido('1114447773') as curto,
          public.cpf_digito_valido(null) as nulo,
          public.cpf_digito_valido('111.444.777-35') as formatado`,
        [CPF_VALIDO, CPF_DESLOCADO]);
      expect(r.valido).toBe(true);
      expect(r.deslocado).toBe(false);
      expect(r.repetido).toBe(false);
      expect(r.curto).toBe(false);
      // ficha sem CPF conta como invalida: `not cpf_digito_valido(...)` precisa
      // de true, nao de NULL, para o grupo ser flagrado
      expect(r.nulo).toBe(false);
      expect(r.formatado).toBe(true);
    });
  });

  describe("portao de gestao", () => {
    it("recusa quem nao e gestao nas duas funcoes de leitura", async () => {
      await comoPapel(db, LUANA);
      try {
        await expect(db.query("select * from public.reconciliacao_dono_caso_aluno()")).rejects.toThrow(/42501|somente a gestao/);
        await expect(db.query("select * from public.fichas_duplicadas_revisao()")).rejects.toThrow(/42501|somente a gestao/);
      } finally {
        await voltarDono(db);
      }
    });
  });

  describe("rollback", () => {
    it("remove os 4 objetos e o gatilho", async () => {
      await db.exec(ler(ROLLBACK));
      const f = await q1(db,
        `select count(*)::int as n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname in
            ('cpf_digito_valido','reconciliacao_dono_caso_aluno','fichas_duplicadas_revisao','_caso_herda_do_aluno')`);
      expect(f.n).toBe(0);
      const t = await q1(db, "select count(*)::int as n from pg_trigger where tgname = 'trg_caso_herda_do_aluno'");
      expect(t.n).toBe(0);
    });
  });
});
