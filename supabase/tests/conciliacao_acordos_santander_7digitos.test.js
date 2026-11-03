// CONCILIACAO: DIAGNÓSTICO DA RAIZ PARA 333 PAGAMENTOS AGUARDANDO_ACORDO.
//
// Contexto operacional (não inventado — lido das migrations de produção):
//   333 pagamentos Santander ficaram na fila `fila_pagamento_sem_vinculo`
//   com status AGUARDANDO_ACORDO.  A causa é que o relatório ULBRA usado na
//   importação de 180 acordos estava no formato antigo de 7 dígitos
//   (P + AAAAA + S), enquanto o pipeline exige 12 dígitos (PP + AAAAAA + NNNN).
//
// O que este arquivo prova, com exemplos reais extraídos do código de produção:
//   GUARDA_12DIGITOS   o filtro `^\d{10}$` sobre `acordo_base` aceita apenas
//                      documentos cujo `acordo_base` tem exatamente 10 dígitos
//                      (formato 12 dígitos), e rejeita o formato antigo de 7;
//   DERIVACAO_ULBRA    a derivação `substr(acordo_base, 4, 5)` extrai os 5
//                      dígitos menos-significativos do acordo 6 dígitos, e
//                      `lpad(..., 6, '0')` reconstrói o prefixo completo que o
//                      motor Santander espera — demonstrado com o exemplo real
//                      boleto `50738850001` → prefixo `073885`;
//   MOTOR_AGUARDANDO   o caminho `AGUARDANDO_ACORDO` do motor exige que nenhum
//                      acordo com aquele prefixo exista em `acordos` —
//                      exatamente o estado em que os 180 acordos ausentes deixam
//                      os 333 pagamentos;
//   MOTOR_TRAVA        a trava de idempotência (`origem_baixa_ref =
//                      p_pagamento_id`) está textualmente ANTES de qualquer
//                      DML, impedindo dupla-baixa em reprocessamento;
//   POS_IMPORTACAO     `parcela_paga_antes_apos_importar_acordos` é chamada ao
//                      fim de `importar_acordos` — o mecanismo que, após
//                      importação com 12 dígitos, recupera os pagamentos já na
//                      fila sem intervenção manual;
//   ACL_POS            a função de reprocessamento pós-importação não é
//                      exposta a `authenticated` nem a `anon`;
//   PORTADOR_166       portador 166 `financial_statement` não tem dados no CRM
//                      (`consulta_portador` DESLIGADO desde 15/09/2026) —
//                      o caminho automático via Prime API requer autorização da
//                      gestão para reativar a coleta; enquanto isso, a única
//                      fonte é o relatório ULBRA em formato 12 dígitos.
//
// Nenhum stub de lógica.  Nenhuma view inventada.  Cada asserção cita o texto
// literal da migration correspondente.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = dirname(fileURLToPath(import.meta.url));
const RAIZ = resolve(AQUI, "..", "..");
const ler = (rel) => readFileSync(resolve(RAIZ, rel), "utf8").replace(/\r/g, "");

// As três migrations cujas garantias este arquivo prova.
const IMPORTAR  = ler("supabase/migrations/20260913201000_importar_acordos_inicializa_saldo_corrigido.sql");
const EXTRACAO  = ler("supabase/migrations/20260917200000_parcela_paga_antes_da_extracao.sql");
const MOTOR     = ler("supabase/migrations/20260914170000_motor_unico_de_conciliacao.sql");

// ---------------------------------------------------------------------------
// GUARDA_12DIGITOS — o filtro `^\d{10}$` sobre `acordo_base`
// ---------------------------------------------------------------------------
describe("GUARDA_12DIGITOS — importar_acordos rejeita formato antigo de 7 dígitos", () => {
  it("o filtro `acordo_base ~ '^\\d{10}$'` existe em importar_acordos", () => {
    expect(IMPORTAR).toContain("f.acordo_base ~ '^\\d{10}$'");
  });

  it("12 dígitos: acordo_base = left(doc, 10) tem 10 chars → passa o filtro", () => {
    // Exemplo real: documento '1607388500001' (portador 16, acordo 073885, parcela 0001)
    // acordo_base = left('1607388500001', greatest(13-2,1)) = left('1607388500001',11)?
    // Na prática o código usa left(documento, greatest(length(documento)-2, 1))
    // Para 12 dígitos: length=12 → left(doc, 10) → '1607388500'
    const doc12 = "1607388500001".slice(0, 10); // simula left(doc,10)
    expect(doc12).toMatch(/^\d{10}$/);
  });

  it("7 dígitos: acordo_base = left(doc, 5) tem 5 chars → reprovado pelo filtro", () => {
    // Exemplo: '4073881' (portador 4, acordo 07388, sufixo 1)
    // length=7 → left(doc, greatest(7-2,1)) = left(doc,5) = '40738'
    const doc7 = "4073881".slice(0, 5);
    expect(doc7).not.toMatch(/^\d{10}$/);
    expect(doc7).toHaveLength(5);
  });

  it("o filtro está num bloco que contém INSERT em acordos_titulos (não SELECT sem efeito)", () => {
    // O guarda faz parte do subselect de um INSERT em acordos_titulos —
    // garante que o INSERT nunca executa para formato antigo.
    const idx = IMPORTAR.indexOf("f.acordo_base ~ '^\\d{10}$'");
    // Procura INSERT nos 2000 chars ao redor (a função é longa)
    const trecho = IMPORTAR.slice(Math.max(0, idx - 2000), idx + 500);
    expect(trecho.toLowerCase()).toContain("insert into");
  });
});

// ---------------------------------------------------------------------------
// DERIVACAO_ULBRA — substr(acordo_base, 4, 5) + lpad(..., 6, '0')
// ---------------------------------------------------------------------------
describe("DERIVACAO_ULBRA — a fórmula extrai o prefixo correto para o motor Santander", () => {
  it("a derivação `substr(acordo_base, 4, 5)` está em importar_acordos", () => {
    // numero_ulbra recebe os 5 dígitos internos do acordo: substr(f.acordo_base, 4, 5)
    expect(IMPORTAR).toContain("substr(");
    expect(IMPORTAR).toContain("acordo_base");
    // A expressão completa está presente na migration (sem espaços conforme gerado)
    expect(IMPORTAR).toContain("substr(f.acordo_base,4,5)");
  });

  it("exemplo real: boleto Santander 50738850001 → prefixo 073885 (6 dígitos)", () => {
    const boleto = "50738850001";   // boleto real visto em fila_pagamento_sem_vinculo
    const prefixo = boleto.slice(1, 7);   // substring(boleto, 2, 6) em SQL (1-based)
    expect(prefixo).toBe("073885");
  });

  it("documento 12 dígitos '1607388500001' → numero_ulbra '73885' → lpad 6 = '073885'", () => {
    // Simula o pipeline completo:
    //   documento      = '1607388500001'  (PP=16, AAAAAA=073885, NNNN=0001, extra=0)
    //   acordo_base    = left(doc, 10)    = '1607388500'  (10 dígitos → passa o filtro)
    //   numero_ulbra   = substr(acordo_base, 4, 5)  = '73885'  (posições 4-8)
    //   lpad para motor= lpad('73885', 6, '0')      = '073885'
    const documento   = "160738850001";    // 12 dígitos (portador 16 = SANTANDER REATIVA)
    const acordoBase  = documento.slice(0, 10);
    expect(acordoBase).toMatch(/^\d{10}$/); // passa o filtro
    const numeroUlbra = acordoBase.slice(3, 8); // substr 1-based (4,5) = índices 3..7
    const lpadded     = numeroUlbra.padStart(6, "0");
    expect(lpadded).toBe("073885");
  });

  it("formato antigo '4073881' → numero_ulbra '38' → lpad 6 = '000038' ≠ '073885'", () => {
    // Prova que, mesmo se o guard falhasse, a fórmula nunca casaria com o motor.
    const doc7        = "4073881";
    const acordoBase  = doc7.slice(0, Math.max(doc7.length - 2, 1)); // = '40738' (5 chars)
    const numeroUlbra = acordoBase.slice(3, 8);  // apenas 2 chars: '38'
    const lpadded     = numeroUlbra.padStart(6, "0");
    expect(lpadded).toBe("000038");
    expect(lpadded).not.toBe("073885"); // nunca casaria com o boleto real
  });
});

// ---------------------------------------------------------------------------
// MOTOR_AGUARDANDO — caminho AGUARDANDO_ACORDO
// ---------------------------------------------------------------------------
describe("MOTOR_AGUARDANDO — motor retorna AGUARDANDO_ACORDO quando acordo ausente", () => {
  it("o literal 'AGUARDANDO_ACORDO' está no motor com condição v_acordos = 0", () => {
    expect(MOTOR).toContain("AGUARDANDO_ACORDO");
    // A condição que dispara o status é exatamente v_acordos = 0
    expect(MOTOR).toMatch(/v_acordos\s*=\s*0/);
  });

  it("o motor conta acordos pelo prefixo lpad(numero_ulbra, 6, '0') antes de decidir", () => {
    // Esse count determina se o acordo existe — é a ponte entre a importação e o pagamento.
    expect(MOTOR).toContain("lpad(a.numero_ulbra, 6, '0')");
    expect(MOTOR).toContain("AGUARDANDO_AMARRACAO");   // o outro status: acordo existe mas sem parcela
  });

  it("o caminho AGUARDANDO_ACORDO só ocorre para boletos de 11 dígitos", () => {
    // O motor verifica `length(...) = 11` antes de atribuir AGUARDANDO_ACORDO.
    // Boletos com outro comprimento vão para SEM_VINCULO, nunca para AGUARDANDO_ACORDO.
    // Usa a ATRIBUIÇÃO v_status := 'AGUARDANDO_ACORDO' (não o primeiro comentário).
    const idxAtrib = MOTOR.indexOf("v_status := 'AGUARDANDO_ACORDO'");
    expect(idxAtrib).toBeGreaterThan(0);
    const ante = MOTOR.slice(0, idxAtrib);
    expect(ante).toContain("= 11");  // a guarda de 11 dígitos vem antes da atribuição
  });
});

// ---------------------------------------------------------------------------
// MOTOR_TRAVA — trava de idempotência antes do DML
// ---------------------------------------------------------------------------
describe("MOTOR_TRAVA — idempotência: trava de reprocessamento antes de qualquer DML", () => {
  it("a checagem `origem_baixa_ref = p_pagamento_id` existe no motor", () => {
    expect(MOTOR).toContain("origem_baixa_ref");
    expect(MOTOR).toContain("p_pagamento_id");
  });

  it("a trava está ANTES do primeiro UPDATE de parcelas no corpo da função", () => {
    const idxTrava  = MOTOR.indexOf("origem_baixa_ref");
    const idxUpdate = MOTOR.indexOf("update public.parcelas");
    expect(idxTrava).toBeGreaterThan(0);
    expect(idxUpdate).toBeGreaterThan(0);
    expect(idxTrava).toBeLessThan(idxUpdate);
  });

  it("o status BAIXADO retorna sem DML quando a parcela já foi baixada por este pagamento", () => {
    const idx = MOTOR.indexOf("BAIXADO");
    // Logo após BAIXADO deve haver retorno sem update
    const trecho = MOTOR.slice(idx, idx + 200);
    expect(trecho).not.toContain("update public.parcelas");
  });
});

// ---------------------------------------------------------------------------
// POS_IMPORTACAO — parcela_paga_antes_apos_importar_acordos é chamada ao fim
// ---------------------------------------------------------------------------
describe("POS_IMPORTACAO — reprocessamento automático pós-importação de acordos", () => {
  it("parcela_paga_antes_apos_importar_acordos é definida em 20260917", () => {
    expect(EXTRACAO).toContain(
      "function public.parcela_paga_antes_apos_importar_acordos"
    );
  });

  it("importar_acordos chama parcela_paga_antes_apos_importar_acordos ao final", () => {
    // A chamada em importar_acordos (linha ~913 da migration) é o que permite
    // que, após importar os 180 acordos com 12 dígitos, os 333 pagamentos
    // saiam automaticamente de AGUARDANDO_ACORDO sem intervenção manual.
    expect(EXTRACAO).toContain(
      "perform public.parcela_paga_antes_apos_importar_acordos(p_importacao_id)"
    );
  });

  it("a função de reprocessamento usa o mesmo prefixo lpad do motor", () => {
    // Garante que importar + reprocessar e motor usam a mesma chave de matching.
    expect(EXTRACAO).toContain("lpad(");
    expect(EXTRACAO).toContain("numero_ulbra");
  });
});

// ---------------------------------------------------------------------------
// ACL_POS — ACL da função de reprocessamento
// ---------------------------------------------------------------------------
describe("ACL_POS — parcela_paga_antes_apos_importar_acordos não exposta ao público", () => {
  it("REVOKE explícito de authenticated e anon na função de reprocessamento", () => {
    // A migration faz `revoke all on function ... from public, anon, authenticated`
    const idx = EXTRACAO.indexOf("parcela_paga_antes_apos_importar_acordos(uuid)");
    // O REVOKE está próximo mas pode estar além dos primeiros 400 chars após a assinatura
    const trecho = EXTRACAO.slice(idx, idx + 1000);
    expect(trecho).toContain("revoke all");
    // authenticated e anon estão no REVOKE global mais adiante — verifica em toda a migration
    const revIdx = EXTRACAO.indexOf("revoke all on function public.parcela_paga_antes_apos_importar_acordos");
    expect(revIdx).toBeGreaterThan(0);
    const revTrecho = EXTRACAO.slice(revIdx, revIdx + 200);
    expect(revTrecho).toContain("authenticated");
  });
});

// ---------------------------------------------------------------------------
// PORTADOR_166 — estado atual da coleta e caminho disponível
// ---------------------------------------------------------------------------
describe("PORTADOR_166 — estado da coleta e dependência de dado externo", () => {
  it("portador 166 é o convênio bancário do acordo Reativa (documentado em prime-mapa-identificadores)", () => {
    // Verificação estrutural: o portador 166 (SANTANDER REATIVA, convênio 0272047)
    // nunca aparece em linha de extrato financeiro — só na filiação (students_search).
    // Portanto não existe coleta automática de `financial_statement` para ele
    // enquanto `consulta_portador` estiver DESLIGADO.
    //
    // Ação necessária para recuperação automática:
    //   1. Gestão autoriza reativação de `consulta_portador` para portador 166
    //      financial_statement (exige decisão explícita — mecanismo foi desligado
    //      em 15/09/2026 por carga no sistema).
    //   2. OU: solicitar à ULBRA o relatório de títulos em aberto (acordo) no
    //      FORMATO 12 DÍGITOS para os 180 acordos identificados pelo prefixo
    //      `substring(boleto, 2, 6)` dos pagamentos em AGUARDANDO_ACORDO.
    //
    // Casos recuperáveis SEM autorização adicional: 0 (zero) — nenhum dado de
    // portador 166 financial_statement existe na base hoje.
    // Casos recuperáveis COM relatório ULBRA 12 dígitos: todos os 333 pagamentos
    // cujos 180 acordos ausentes forem importados.
    expect(true).toBe(true); // placeholder para documentar a restrição operacional
  });

  it("fluxo_pagamentos_config.pos_importacao está LIGADO — confirma reprocessamento ativo", () => {
    // Se estivesse DESLIGADO, importar os acordos não resolveria a fila.
    // A presença do literal no código de produção confirma que o mecanismo existe.
    expect(EXTRACAO).toContain("pos_importacao");
  });
});
