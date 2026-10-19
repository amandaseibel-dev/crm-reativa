-- =============================================================================
-- REGISTRO DOCUMENTAL DOS CORPOS VIVOS -- NAO REAPLICAR
-- =============================================================================
-- Capturado de producao em 19/10/2026 por pg_get_functiondef / pg_proc.prosrc.
--
-- POR QUE ESTE ARQUIVO EXISTE. Tres versoes de 15/10/2026 estao registradas em
-- supabase_migrations.schema_migrations com o campo `statements` contendo
-- DESCRICAO em portugues, nao SQL -- logo o comando aplicado nao e recuperavel
-- do registro. O corpo vivo passa a ser a unica fonte, e e isso que esta aqui.
--
--   20261015124500  retorno_futuro_so_bloqueia_agendamento_do_operador
--   20261015154500  data_ultimo_acionamento_do_caso_no_fuso_de_brasilia
--   20261015155000  acoes_massivas_fora_do_universo
--
-- NAO REAPLICAR EM PRODUCAO: producao JA esta nesse estado. Reaplicar nao
-- melhora nada e, no caso do gatilho abaixo, um arquivo ANTIGO do repo faria
-- regredir a regra de fuso. Este arquivo e registro e referencia, nao receita.
-- A guarda abaixo aborta o arquivo inteiro se alguem o executar de uma vez.
--
-- A INTEGRIDADE E TESTADA: supabase/tests/deriva_corpos_vivos_20261019_integridade.test.js
-- confere, a cada CI, que cada corpo transcrito aqui ainda bate com o md5 e o
-- tamanho documentados. Transcricao corrompida quebra o teste.
-- =============================================================================

do $guarda$
begin
  raise exception
    'REGISTRO DOCUMENTAL (19/10/2026): este arquivo NAO deve ser executado. Producao ja esta neste estado; ver supabase/audits/acoes_massivas_deriva_corpos_vivos_producao_20261019.sql'
    using errcode = '55000';
end;
$guarda$;

-- -----------------------------------------------------------------------------
-- 1. fn_atualizar_ultimo_acionamento()   md5=e1bfc3930535104ec515f8c514e0b0d7  chars=987
-- -----------------------------------------------------------------------------
-- Versao 20261015154500. A diferenca contra o repo esta no UPDATE de casos: duas
-- ocorrencias de (new.registrado_em at time zone 'America/Sao_Paulo')::date onde
-- o arquivo 20261003083400 do repo grava new.registrado_em::date, em UTC.
-- E O UNICO CASO EM QUE O ARQUIVO DO REPO E PIOR QUE PRODUCAO: reaplicar a
-- cadeia faria casos.data_ultimo_acionamento voltar ao dia errado perto da
-- virada, e esse campo governa fidelizacao de 10 dias, "nunca acionado" e
-- cobertura.
-- ACL em producao: {postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}
CREATE OR REPLACE FUNCTION public.fn_atualizar_ultimo_acionamento()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_uuid uuid;
begin
  if not public.eh_tipo_acionamento(new.tipo) then
    return new;
  end if;

  begin
    v_uuid := new.aluno_id::uuid;
  exception when others then
    return new;
  end;

  update public.alunos a
     set data_ultimo_acionamento = new.registrado_em
   where a.id = v_uuid
     and (a.data_ultimo_acionamento is null
          or a.data_ultimo_acionamento < new.registrado_em);

  update public.casos c
     set data_ultimo_acionamento = (new.registrado_em at time zone 'America/Sao_Paulo')::date
   where c.aluno_id = v_uuid
     and (c.data_ultimo_acionamento is null
          or c.data_ultimo_acionamento < (new.registrado_em at time zone 'America/Sao_Paulo')::date);

  if new.tipo not in ('ACAO_MASSIVA_EXTERNA', 'ACAO_MASSIVA_EXTERNA_EMAIL') then
    begin
      perform public.recalcular_situacao_aluno(v_uuid, 'acionamento');
    exception when others then
      null;
    end;
  end if;

  return new;
exception when others then
  return new;
end;
$function$
;

-- -----------------------------------------------------------------------------
-- 2. acoes_massivas_fora_do_universo()   md5=c2c7514c42e9a1cb22271d0bd3b05c63  chars=1075
-- -----------------------------------------------------------------------------
-- Versao 20261015155000. Funcao NOVA, que nao existe em arquivo nenhum do repo.
-- Leitura pura (STABLE) e aditiva: audita quem tem titulo nao quitado com valor
-- > 0 e mesmo assim nao entra em acoes_massivas_universo. Nao altera a fila nem
-- os motivos de indisponibilidade.
-- ACL em producao: {postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}
-- COMMENT em producao: "Auditoria das Acoes Massivas: quem tem titulo nao quitado com valor > 0 e MESMO ASSIM nao entra em acoes_massivas_universo, agrupado pelo motivo (situacao do titulo ou boleto de acordo). Leitura pura e aditiva: nao altera a fila nem os motivos de indisponibilidade."
CREATE OR REPLACE FUNCTION public.acoes_massivas_fora_do_universo()
 RETURNS TABLE(motivo_fora text, alunos integer, titulos integer, valor numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '60s'
AS $function$ declare v_sistema boolean := (auth.role() = 'service_role') or (auth.jwt() is null and session_user in ('postgres','reativa_responsavel_executor')); begin if not v_sistema and not public.usuario_e_gestao() then raise exception 'Acesso negado: auditoria do universo das acoes massivas restrita a gestao.' using errcode = '42501'; end if; return query with u as materialized (select x.aluno_id from public.acoes_massivas_universo('{"operador":"todos"}'::jsonb) x), cand as (select t.aluno_id, case when coalesce(t.tipo_boleto, '') = 'Acordo' then 'BOLETO_DE_ACORDO' else 'SITUACAO_' || upper(coalesce(nullif(btrim(t.situacao), ''), 'NULA')) end as motivo, coalesce(t.valor_cobranca_ajustado, t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0) as v from public.acordos_titulos t where t.aluno_id is not null and coalesce(lower(t.status), '') <> 'quitada') select c.motivo, count(distinct c.aluno_id)::int, count(*)::int, round(sum(c.v), 2) from cand c where c.v > 0 and not exists (select 1 from u where u.aluno_id = c.aluno_id) group by c.motivo order by 4 desc; end; $function$
;

-- -----------------------------------------------------------------------------
-- 3. acoes_massivas_universo(jsonb)   md5=f49209f6358dc9b0c22199c455d6d87d  chars=13970
-- -----------------------------------------------------------------------------
-- CORPO NAO TRANSCRITO AQUI, DE PROPOSITO, e a razao esta medida:
--
--   cadeia de migrations da main .................. 3c1fa046 / 13.598 chars
--   + 20261006113000_acoes_massivas_responsaveis_por_lado.sql
--     (arquivo que existe SO na arvore de trabalho local, fora do Git)
--     ............................................. 75e2517e / 13.852 chars
--   + os 2 patches de 20261015124500 (abaixo) ..... eb60bb84 / 13.929 chars
--   producao ...................................... f49209f6 / 13.970 chars
--
-- Sobram 41 caracteres e 5 linhas, e produção tem 1 linha de comentario A MAIS
-- (269 linhas / 25 de comentario contra 274 / 24 da reconstrucao). Ou seja: a
-- deriva restante e de FORMATACAO E COMENTARIO, nao de regra -- os marcadores de
-- comportamento batem exatamente nas duas versoes: 1 ocorrencia de 'OPERADOR' e
-- 2 de 'retorno_origem'.
--
-- Transcrever 13.970 caracteres a mao teria risco de erro maior que o valor do
-- registro, e o md5 esta travado no teste de integridade de qualquer forma.
-- Para fechar byte a byte: capturar pg_get_functiondef direto de producao.
--
-- O QUE 20261015124500 MUDOU, linha a linha (medido pelo diff da reconstrucao):
--
--   CTE pop, antes:
--     select a.id, b.anos, a.responsavel_atual_email as resp, a.data_retorno,
--   depois:
--     select a.id, b.anos, a.responsavel_atual_email as resp, a.data_retorno, a.retorno_origem,
--
--   motivo f_ret, antes:
--            (k.data_retorno is not null and k.data_retorno > v_hoje) as f_ret,
--   depois:
--            (k.data_retorno is not null and k.data_retorno > v_hoje and upper(coalesce(k.retorno_origem, '')) like 'OPERADOR%') as f_ret,
--
-- EFEITO, e importa para a tabulacao de 19/10: retorno futuro de origem
-- AUTOMATICO deixou de esconder aluno da massiva; so o agendado pelo OPERADOR
-- bloqueia. Quem segura a janela da campanha e a recencia por canal.
-- COMMENT em producao diz exatamente isso.

-- -----------------------------------------------------------------------------
-- 4. fn_sync_acionamento_alunos_para_casos()   md5=ea3034d6bfc5b7b0dcd58f9c257efa8e  chars=456
-- -----------------------------------------------------------------------------
-- SEM DERIVA, conferido por md5: o corpo vivo e identico ao do arquivo
-- supabase/migrations/20260806190000_sync_data_ultimo_acionamento_alunos_para_casos.sql,
-- que ja usa (… at time zone 'America/Sao_Paulo')::date. Nao precisa de registro
-- nem de regularizacao. Fica anotado para ninguem procurar deriva onde nao tem.

-- -----------------------------------------------------------------------------
-- 5. registrar_acao_massiva(...)   md5=633a4ebe34819048da2e7b0247e53ac2  chars=6774
-- -----------------------------------------------------------------------------
-- SEM DERIVA DE COMPORTAMENTO. Antes de 19/10 a diferenca entre a cadeia do repo
-- e producao era de 391 caracteres de COMENTARIO, em 3 blocos (o diff dos dois
-- corpos acusa apenas linhas que comecam com --). Depois da versao
-- 20261019132433, o arquivo do repo reproduz o corpo vivo byte a byte
-- (o md5 do cabecalho desta secao), e isso e afirmado no
-- teste supabase/tests/acao_massiva_tabula_com_retorno_10_dias.test.js.

-- =============================================================================
-- CONFERENCIA EM PRODUCAO (somente leitura; rodar a mao quando quiser revalidar)
-- =============================================================================
-- select p.oid::regprocedure as funcao, md5(p.prosrc) as md5, length(p.prosrc) as chars
--   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--  where n.nspname = 'public'
--    and p.proname in ('fn_atualizar_ultimo_acionamento',
--                      'acoes_massivas_fora_do_universo',
--                      'acoes_massivas_universo',
--                      'fn_sync_acionamento_alunos_para_casos',
--                      'registrar_acao_massiva')
--  order by 1;
