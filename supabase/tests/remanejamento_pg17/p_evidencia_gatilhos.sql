-- EVIDENCIA dos gatilhos de alunos, casos e acordos (B3).
-- A lista ESPERADA sao os gatilhos de producao de 18/11 (estruturas_prod.json), com a decisao da
-- triagem (triagem_gatilhos.json). A comparacao e ELEMENTO A ELEMENTO com pg_trigger do CI:
--   (1) cada gatilho esperado: esta carregado, OU foi EXCLUIDO com justificativa;
--   (2) cada INCLUIR esperado tem que estar carregado;
--   (3) gatilho carregado que nao esta na lista de producao e falha.
-- Conta avaliados e aprovados e exige avaliados = total da lista (nao pode ser vazio).
-- Contagem de execucao NAO e prova de ausencia e nao entra na decisao.
\i lib.sql
select pg_temp.como('amanda.seibel@aelbra.com.br');

create temp table esperado (tabela text, gatilho text, decisao text, evidencia text) on commit preserve rows;
insert into esperado values
('acordos', 'trg_acordo_alerta_resolve_acordo', 'EXCLUIR', 'definicao: UPDATE OF status + WHEN; md5_def 5278397827057691'),
('acordos', 'trg_acordo_bloquear_duplicado', 'EXCLUIR', 'corpo md5 ad2a92b434687861b88f41c7a011c156; UPDATE OF status,valor_total,qtd_parcelas,aluno_id'),
('acordos', 'trg_acordo_herda_responsavel', 'SEM_CLASSE', ''),
('acordos', 'trg_acordo_status_reavalia_titulos', 'EXCLUIR', 'definicao: UPDATE OF status + WHEN; corpo md5 66b6165312d0302c738c107cfd6b7cd8'),
('acordos', 'trg_aluno_segue_dono_do_acordo', 'SEM_CLASSE', ''),
('acordos', 'trg_atribuir_responsavel_por_acordo', 'SEM_CLASSE', ''),
('acordos', 'trg_audit', 'EXCLUIR', 'corpo fn_audit_generic md5 8cda58d54687edf35bde9280269141df (so audit_log)'),
('acordos', 'trg_efetividade_invalidar_acordos', 'EXCLUIR', 'corpo md5 135fbc0e9ec0075c45029f5bfb113ca1 (statement-level, excecao capturada)'),
('acordos', 'trg_fila_acordo_fecha_ao_encerrar', 'EXCLUIR', 'definicao: UPDATE OF status; corpo md5 be0e198f3fb61fd12b7fc3ad5b75a90c'),
('acordos', 'trg_guard_resp_acordo', 'SEM_CLASSE', ''),
('acordos', 'trg_recalc_acordo', 'INCLUIR', 'carregado no CI'),
('acordos', 'trg_titulo_quita_com_o_acordo', 'EXCLUIR', 'definicao: UPDATE OF status; corpo md5 49197258a3c62c8f527ffe630c7bc4f7'),
('acordos', 'trg_titulos_por_status_acordo', 'EXCLUIR', 'definicao: UPDATE OF status; corpo md5 d9302864c0443269bdf028638f27de75'),
('alunos', 'trg_acionamento_nao_volta_para_nulo', 'SEM_CLASSE', ''),
('alunos', 'trg_aluno_concluir_retorno_adm_link', 'EXCLUIR', 'definicao: UPDATE OF status_atual + WHEN old=LINK_PRONTO; corpo md5 a8825df4fe90d09707f75a70e122eada'),
('alunos', 'trg_aluno_encerramento_propaga', 'EXCLUIR', 'corpo md5 37baf683c2d7c84093fead5e566896af (so age em status terminal); UPDATE OF status_atual'),
('alunos', 'trg_aluno_estado_anterior', 'EXCLUIR', 'definicao: WHEN old.status_atual IS DISTINCT FROM new.status_atual; corpo md5 33914741ffef71b4aa31873669c905fc'),
('alunos', 'trg_aluno_reset_retorno_confirmado', 'SEM_CLASSE', ''),
('alunos', 'trg_alunos_retorno_origem', 'SEM_CLASSE', ''),
('alunos', 'trg_atualizar_nome_normalizado', 'EXCLUIR', 'definicao: UPDATE OF nome; corpo md5 18ccc8900756115258dab02b2f514b2a'),
('alunos', 'trg_audit_del', 'EXCLUIR', 'definicao: AFTER DELETE; corpo md5 8cda58d54687edf35bde9280269141df'),
('alunos', 'trg_audit_responsavel_aluno', 'EXCLUIR', 'corpo md5 62eec59fbb06949ce0551d5806dade9f (so audit_log)'),
('alunos', 'trg_encerramento_so_gestao', 'INCLUIR', 'carregado no CI'),
('alunos', 'trg_fechar_confirmacao_ao_quitar', 'EXCLUIR', 'definicao: UPDATE OF status_atual,status_jornada; corpo md5 735b673618064774f33c2c4d98aa1a1b'),
('alunos', 'trg_guard_resp_aluno', 'SEM_CLASSE', ''),
('alunos', 'trg_nome_do_operador_no_aluno', 'SEM_CLASSE', ''),
('alunos', 'trg_sincronizar_alunos_unificados', 'EXCLUIR', 'corpo md5 8705c4d0b2d63a31b0eafd7fb2bfa60b (so alunos_unificados)'),
('alunos', 'trg_sync_acionamento_alunos_para_casos', 'INCLUIR', 'carregado no CI'),
('alunos', 'trg_sync_casos_resp_aluno', 'SEM_CLASSE', ''),
('alunos', 'trg_tabulacao_efeito_financeiro', 'EXCLUIR', 'definicao: UPDATE OF status_jornada; corpo md5 53bb9b5f5aa0ee3e83d47bbb4abdf611'),
('alunos', 'trg_tabulacao_redireciona', 'EXCLUIR', 'definicao: UPDATE OF status_jornada; corpo md5 e3616eaf5cc3a43d381a9f08f4991778'),
('alunos', 'trg_tabulacao_so_gestao_insert', 'EXCLUIR', 'corpo _encerramento_so_gestao md5 5ff3be8222f1f33d6a679be8b313fec5 (bypass postgres/service_role)'),
('casos', 'trg_audit_del', 'EXCLUIR', 'definicao: AFTER DELETE; corpo md5 8cda58d54687edf35bde9280269141df'),
('casos', 'trg_auditar_encerramento_operacional', 'EXCLUIR', 'corpo md5 c84584c051600365c5dd5c56ac735a71 (producao, consulta 18/11; so casos_encerramento_auditoria)'),
('casos', 'trg_auditar_nao_acionar', 'EXCLUIR', 'definicao: UPDATE OF nao_acionar; corpo md5 d9481f2ee95ad12936a79f61e8209358'),
('casos', 'trg_bloquear_alteracoes_restritas_casos', 'INCLUIR', 'carregado no CI; md5 trigger 49af8ba2fe92dea3ea13adf7181b9216 = producao (coletado 2026-11-19 09:35 UTC)'),
('casos', 'trg_casos_set_encerrado_operacional', 'INCLUIR', 'carregado no CI'),
('casos', 'trg_fechar_confirmacao_ao_quitar_caso', 'EXCLUIR', 'definicao: UPDATE OF status_atual,quitado_em,origem_quitacao; corpo md5 d9e8b64578408c46d9df1d09ccbbe717'),
('casos', 'trg_giro_limpar_marca', 'SEM_CLASSE', ''),
('casos', 'trg_nome_do_operador_no_caso', 'SEM_CLASSE', ''),
('casos', 'trg_sync_alunos_apos_casos', 'SEM_CLASSE', ''),
('casos', 'trg_zz_caso_nao_duplica_aluno', 'EXCLUIR', 'corpo _caso_nao_duplica_aluno md5 b06f5ef76c0e72e4b498676971c288eb; indice unico carregado'),
('casos', 'trg_zz_caso_nao_duplica_aluno_before', 'EXCLUIR', 'corpo _caso_nao_duplica_aluno md5 b06f5ef76c0e72e4b498676971c288eb (BEFORE)'),
('casos', 'trigger_impor_teto_operador', 'SEM_CLASSE', ''),
('casos', 'trigger_repor_caso_operador', 'INCLUIR', 'carregado no CI');

create temp table carregado on commit preserve rows as
  select c.relname::text as tabela, t.tgname::text as gatilho
    from pg_trigger t join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
   where not t.tgisinternal and c.relname in ('alunos','casos','acordos');

do $$
declare ex record; cl record; n_total int; n_av int := 0; n_ok int := 0; n_fal int := 0; n_extra int := 0;
begin
  select count(*) into n_total from esperado;
  for ex in select * from esperado loop
    n_av := n_av + 1;
    if exists (select 1 from carregado k where k.tabela = ex.tabela and k.gatilho = ex.gatilho) then
      n_ok := n_ok + 1;
    elsif ex.decisao = 'INCLUIR' then
      n_fal := n_fal + 1; raise notice 'FALHA: % (%) e INCLUIR e nao esta carregado', ex.gatilho, ex.tabela;
    elsif ex.decisao = 'EXCLUIR' and coalesce(ex.evidencia, '') <> '' and ex.evidencia not like 'PENDENTE%' then
      n_ok := n_ok + 1;
    else
      n_fal := n_fal + 1; raise notice 'FALHA: % (%) sem classificacao valida (%)', ex.gatilho, ex.tabela, ex.decisao;
    end if;
  end loop;
  -- Unico gatilho carregado fora da lista de producao: o que a PROPRIA migracao cria (ainda nao existe em
  -- producao). Excecao explicita e nomeada; qualquer outro extra e falha.
  for cl in select * from carregado k where not exists (
        select 1 from esperado x where x.tabela = k.tabela and x.gatilho = k.gatilho) loop
    if cl.gatilho = 'trg_cg_marcador_segue_a_marca' then
      raise notice 'novo desta migracao (fora da producao, esperado): % (%)', cl.gatilho, cl.tabela;
    else
      n_extra := n_extra + 1; raise notice 'FALHA: % (%) carregado mas ausente da lista de producao', cl.gatilho, cl.tabela;
    end if;
  end loop;
  raise notice 'gatilhos: %/% avaliados, % aprovados, % falhas, % extras', n_av, n_total, n_ok, n_fal, n_extra;
  perform pg_temp.afirma(n_total = 45 and n_av = n_total and n_fal = 0 and n_extra = 0,
    format('gatilhos: %s avaliados, %s aprovados, %s falhas, %s extras', n_av, n_ok, n_fal, n_extra));
end $$;
select 'EVIDENCIA OK' as resultado;
