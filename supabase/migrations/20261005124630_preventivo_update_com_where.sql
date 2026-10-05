-- Preventivo: os tres UPDATE da importacao passam a ter WHERE.
--
-- POR QUE. O papel da API traz `safeupdate` pre-carregada
-- (pg_db_role_setting: authenticator -> session_preload_libraries =
-- 'supautils, safeupdate'), e ela age em TODA instrucao da sessao, inclusive
-- dentro de PL/pgSQL. Os tres UPDATE sobre a tabela temporaria `_prev_in`
-- nao tinham WHERE, e a previa morria antes de qualquer leitura:
--
--   2026-10-05 12:24:43 UTC e 12:24:54 UTC
--   POST /rest/v1/rpc/preventivo_lote_previa -> 400
--   ERROR 21000: UPDATE requires a WHERE clause
--   CONTEXT: update _prev_in set celular_aluno = ... email_aluno = ...
--            preventivo_lote_processar(uuid,jsonb,boolean,uuid) linha 42
--            preventivo_lote_previa(uuid,jsonb) linha 3
--
-- `preventivo_lote_confirmar` nunca chegou a rodar.
--
-- O QUE ESTA MIGRATION NAO FAZ. Nao desliga `safeupdate`, nao mexe em
-- `statement_timeout`, nao usa `WHERE true` e nao altera regra nenhuma da
-- importacao. Cada WHERE e a condicao real daquele UPDATE:
--
--   1. contato: so as linhas com exatamente um telefone OU um e-mail. Nas
--      outras o CASE gravaria NULL sobre coluna recem-criada (ja NULL).
--   2. chave: so as linhas que tem de onde tirar identidade -- documento, ou
--      um dos dois vencimentos. Sem nenhum dos tres a linha e sempre recusada
--      adiante (vencimento null => VENCIMENTO_INVALIDO) e sua chave nunca e
--      lida: TODOS os 11 pontos que leem `chave` filtram por `motivo is null`.
--   3. motivo: so as linhas que de fato recebem um motivo de recusa.
--
-- Estado final identico ao anterior, linha por linha.
--
-- PATCH ANCORADO, nao reescrita: le a definicao viva e troca tres trechos.
-- Aborta se qualquer ancora nao casar, para nunca aplicar sobre deriva.

do $patch$
declare
  v_def  text := pg_get_functiondef(
    'public.preventivo_lote_processar(uuid, jsonb, boolean, uuid)'::regprocedure);
  v_novo text;

  de_1 text := '  update _prev_in set
    celular_aluno = case when array_length(celulares, 1) = 1 then celulares[1] end,
    email_aluno   = case when array_length(emails, 1) = 1 then emails[1] end;';
  para_1 text := '  update _prev_in set
    celular_aluno = case when array_length(celulares, 1) = 1 then celulares[1] end,
    email_aluno   = case when array_length(emails, 1) = 1 then emails[1] end
  where array_length(celulares, 1) = 1 or array_length(emails, 1) = 1;';

  de_2 text := '  update _prev_in set chave = coalesce(
    documento,
    coalesce(vencimento::text, ''?'') || ''|'' || coalesce(vencimento_origem::text, ''''));';
  para_2 text := '  update _prev_in set chave = coalesce(
    documento,
    coalesce(vencimento::text, ''?'') || ''|'' || coalesce(vencimento_origem::text, ''''))
  where documento         is not null
     or vencimento        is not null
     or vencimento_origem is not null;';

  de_3 text := '      when vencimento < v_carteira.venc_de or vencimento > v_carteira.venc_ate then ''FORA_DO_PERIODO''
    end;';
  para_3 text := '      when vencimento < v_carteira.venc_de or vencimento > v_carteira.venc_ate then ''FORA_DO_PERIODO''
    end
  where matricula  is null
     or aluno_nome is null
     or vencimento is null
     or coalesce(valor, saldo) is null
     or coalesce(valor, saldo) <= 0
     or vencimento < v_carteira.venc_de
     or vencimento > v_carteira.venc_ate;';
begin
  if position(de_1 in v_def) = 0 then
    raise exception 'Preventivo: ancora 1 (contato) nao encontrada em preventivo_lote_processar.';
  end if;
  if position(de_2 in v_def) = 0 then
    raise exception 'Preventivo: ancora 2 (chave) nao encontrada em preventivo_lote_processar.';
  end if;
  if position(de_3 in v_def) = 0 then
    raise exception 'Preventivo: ancora 3 (motivo) nao encontrada em preventivo_lote_processar.';
  end if;

  v_novo := replace(replace(replace(v_def, de_1, para_1), de_2, para_2), de_3, para_3);

  if v_novo = v_def then
    raise exception 'Preventivo: o patch nao alterou nada -- abortado.';
  end if;

  execute v_novo;
end
$patch$;
