-- CRITICIDADE: "TERMO PENDENTE" PASSA A SIGNIFICAR TERMO PENDENTE
-- =============================================================================
-- O DEFEITO, medido em producao em 22/10/2026, em leitura.
--
-- A criticidade canonica (`alunos.nivel_criticidade`) sai de
-- `calibragem_nivel_criticidade(dias_venc, dias_sem_ac, valor, TERMO_PENDENTE,
-- fim_mes, regras)`. O quarto argumento e montado, em dois lugares, assim:
--
--   c.status_termo is not null and lower(coalesce(c.termo_status_validacao,''))
--     not in ('validado','assinado','aprovado')
--
-- So que `casos.status_termo` NUNCA e nulo e nunca foi outra coisa:
--
--   select count(*), count(*) filter (where status_termo is null),
--          count(distinct status_termo) from public.casos;
--   -- 18.424 linhas | 0 nulos | 1 valor distinto: 'Sem termo'
--   -- e 0 linhas com termo_status_validacao em (validado, assinado, aprovado)
--
-- Ou seja: o valor que significa "NAO tem termo" e lido como "termo pendente",
-- e o peso +2 entra em 100% dos casos, sempre. Um peso constante nao
-- discrimina nada -- ele so empurra a carteira inteira um degrau para cima. E,
-- pior, ele anula exatamente o peso de -2 de `acionado_recente` (<= 7 dias),
-- que existe para o caso SAIR do radar depois do contato.
--
-- A CONSEQUENCIA QUE A OPERACAO RELATOU: "mesmo depois de acionar todos os
-- casos, aparecem alunos URGENTE". Com os pesos vivos (vencido>=5: +2;
-- valor>=5.000: +1; termo: +2; acionado ha <=7 dias: -2) e os limiares vivos
-- (atencao 1, urgente 3, critico 5), um caso vencido com saldo alto soma 3 --
-- URGENTE -- no dia 0 e no dia 7 igualmente. Acionar nao muda a faixa.
-- Em producao: 1.013 dos 1.360 casos URGENTE da carteira ativa estao nessa
-- situacao, acionados nos ultimos 7 dias.
--
-- O QUE MUDA: UMA expressao, em DOIS lugares, e nada mais.
--   de:  c.status_termo is not null and lower(...) not in (...)
--   para: upper(btrim(coalesce(c.status_termo,''))) not in ('', 'SEM TERMO')
--         and lower(...) not in (...)
--
-- Com isso "termo pendente" volta a ser o que o nome diz: existe um termo e ele
-- ainda nao foi validado/assinado/aprovado. O PESO CONTINUA +2 e volta a valer
-- de verdade no dia em que `casos.status_termo` carregar um termo -- ha teste
-- provando que um termo realmente pendente soma +2 e leva a URGENTE mesmo com
-- acionamento de hoje.
--
-- O QUE NAO MUDA, de proposito:
--   * `calibragem_parametros.criticidade_regras`: pesos, limiares e a escada de
--     8/9/10 dias ficam IGUAIS. Esta migration nao escreve em tabela nenhuma.
--   * A escada por dias sem acionamento continua sendo PISO: nenhum caso com 8
--     dias ou mais sem acionamento muda de faixa por causa desta correcao.
--     Medido: dos 3.633 casos que mudam de faixa, 3.571 tem <= 7 dias sem
--     acionamento; os 62 restantes caem de CRITICO para URGENTE e seguem em
--     faixa alta.
--   * `sistema_retorno_termo`, que escreve `nivel_criticidade = 'URGENTE'`
--     direto quando um termo volta, NAO e tocada: o fluxo de retorno de termo
--     continua exatamente como esta.
--   * Distribuicao, fidelizacao, acionamento, saldo, baixa, acordo: nada.
--   * Assinatura, SECURITY DEFINER, search_path, owner e GRANTs das duas
--     funcoes: `create or replace` preserva, e ha teste conferindo.
--
-- ZERO DML: nenhum insert, update ou delete. `alunos.nivel_criticidade` e
-- `casos.criticidade` sao campos DERIVADOS e esta migration nao os reescreve --
-- cada caso so muda quando for recalculado (por evento ou pela virada das
-- 03:00). Para uniformizar na hora existe um passo SEPARADO, preparado e NAO
-- executado, em:
--   supabase/aguardando_aprovacao/20261022220100_recalculo_apos_termo_pendente.sql.pendente
--
-- COMO MUDA: patch ANCORADO, sem corpo retypado aqui. A migration LE a
-- definicao viva com `pg_get_functiondef`, troca so o trecho da ancora e
-- executa. Tudo o que nao e a ancora vem de producao.
--
-- TRES TRAVAS, qualquer uma abortando a transacao inteira:
--   1. md5(prosrc) ANTES = o medido em 22/10/2026, senao RECUSA (producao pode
--      ter derivado desde a medicao);
--   2. ancora EXATAMENTE uma vez na definicao -- conferido em leitura: 1 em
--      cada uma, e o texto novo nao existe em nenhuma das duas;
--   3. md5(prosrc) DEPOIS = o valor PREVISTO, que o proprio banco calculou em
--      leitura simulando o replace (`select md5(replace(prosrc, ancora,
--      novo))`). Verificacao contra alvo conhecido, nao contra "mudou".
-- IDEMPOTENTE: se o md5 ja e o de depois, registra e segue.
--
-- MEDICAO QUE SUSTENTA AS TRAVAS (producao, 22/10/2026, somente leitura):
--   recalcular_situacao_aluno(uuid,text)  eb6b5f79... -> 41475103...  13.357 -> 13.397 chars
--   calibragem_criticidade_auto()         7850e754... -> 638d1fc4...   2.359 ->  2.399 chars
-- Os +40 caracteres em cada uma sao exatamente o tamanho da troca: nada alem
-- da ancora se move.
--
-- POR QUE AS DUAS JUNTAS: `recalcular_situacao_aluno` e o que grava a
-- criticidade do aluno; `calibragem_criticidade_auto` e o que a tela de
-- Calibragem da gestao mostra. Corrigir so uma faria a Calibragem e a carteira
-- do operador discordarem.
--
-- ROLLBACK: supabase/rollbacks/20261022220000_criticidade_termo_pendente_real.rollback.sql
begin;

do $$
declare
  r record;
  v_def text;
  v_novo text;
  v_atual text;
  v_corrigidas int := 0;
  v_ja int := 0;
  v_ancora constant text := $a$c.status_termo is not null and lower(coalesce(c.termo_status_validacao,'')) not in ('validado','assinado','aprovado')$a$;
  v_troca  constant text := $n$upper(btrim(coalesce(c.status_termo,''))) not in ('', 'SEM TERMO') and lower(coalesce(c.termo_status_validacao,'')) not in ('validado','assinado','aprovado')$n$;
begin
  for r in
    select * from (values
      -- assinatura, md5(prosrc) antes, md5(prosrc) previsto depois
      ('public.recalcular_situacao_aluno(uuid,text)',
       'eb6b5f79a247669d50cf311c7bab47a9',
       '41475103b8b7ad363dfdc76c4170c5a8'),
      ('public.calibragem_criticidade_auto()',
       '7850e7543596aff7c00c375d3d0c5a1c',
       '638d1fc4d234699ac395ff24f1f65a86')
    ) as t(assinatura, md5_antes, md5_depois)
  loop
    select md5(p.prosrc) into v_atual
      from pg_proc p where p.oid = r.assinatura::regprocedure;

    if v_atual is null then
      raise exception 'FUNCAO AUSENTE: %', r.assinatura;
    end if;

    if v_atual = r.md5_depois then
      v_ja := v_ja + 1;
      raise notice 'ja corrigida, nada a fazer: %', r.assinatura;
      continue;
    end if;

    -- TRAVA 1
    if v_atual <> r.md5_antes then
      raise exception
        'CORPO INESPERADO em %: md5(prosrc) e %, esperado %. Producao derivou desde a medicao de 22/10/2026 -- reconferir a ancora antes de aplicar.',
        r.assinatura, v_atual, r.md5_antes;
    end if;

    v_def := pg_get_functiondef(r.assinatura::regprocedure);

    -- TRAVA 2
    if (length(v_def) - length(replace(v_def, v_ancora, ''))) / length(v_ancora) <> 1 then
      raise exception 'ANCORA NAO UNICA em %: esperado exatamente 1 ocorrencia.', r.assinatura;
    end if;

    v_novo := replace(v_def, v_ancora, v_troca);
    execute v_novo;

    -- TRAVA 3
    select md5(p.prosrc) into v_atual
      from pg_proc p where p.oid = r.assinatura::regprocedure;
    if v_atual <> r.md5_depois then
      raise exception
        'RESULTADO INESPERADO em %: md5(prosrc) ficou %, previsto %',
        r.assinatura, v_atual, r.md5_depois;
    end if;

    v_corrigidas := v_corrigidas + 1;
    raise notice 'corrigida: % (md5 % -> %)', r.assinatura, r.md5_antes, r.md5_depois;
  end loop;

  raise notice 'termo_pendente real: % corrigida(s), % ja estava(m)', v_corrigidas, v_ja;
end $$;

commit;
