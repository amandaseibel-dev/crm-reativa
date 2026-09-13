-- ============================================================================
-- Sem login, nada de RPC. Fecha o que o relatório de segurança do Supabase
-- apontou em 03/09/2026 (continuação de 20260903400000_salarios_so_amanda,
-- pedido da Amanda: "pode fechar se for para blindar o sistema").
-- ----------------------------------------------------------------------------
-- 1) 47 funções SECURITY DEFINER executáveis pela role `anon` (sem login):
--    44 por EXECUTE herdado de PUBLIC (padrão do Postgres em função antiga),
--    2 por grant explícito a anon (dias_uteis, sistema_sob_carga) e 1 por
--    PUBLIC (acoes_massivas_borderos). 25 são funções de trigger (não dá para
--    chamar por RPC, mas ficam limpas) e 22 são RPCs. Das 22, 18 têm trava
--    interna (app_usuario_ativo / usuario_e_gestao) e devolvem vazio ou erro
--    para quem não está logado; 4 não têm trava nenhuma:
--    aluno_matricula_semestres (lê matrículas por uuid), aluno_contatos_
--    sincronizar (escreve em aluno_contatos), dias_uteis e sistema_sob_carga.
--    Provado em prod: anon executa as 4.
--    Quem chama de verdade é sempre logado: frontend (authenticated), Edge
--    Functions com o JWT do operador ou com service_role, cron (postgres).
--    Nenhum caminho usa a chave anônima sem sessão. authenticated e
--    service_role MANTÊM o EXECUTE; só PUBLIC e anon saem.
--
-- 2) `consulta_financeira_por_aluno` tinha voltado a SECURITY DEFINER: a
--    migration 20260727170000 ligou security_invoker, e o `create or replace
--    view` de 20260828360000 apagou a opção sem querer (reloptions não
--    sobrevivem ao replace). Religa. Quem abre a tela (/financeiro) é a gestão
--    (gerencia, supervisor, administrativo), que passa em usuario_e_gestao()
--    na RLS de alunos, acordos, acordos_titulos e parcelas: para elas não muda
--    nada; muda para quem não devia ler por fora (ex.: usuário do painel da TV).
--
-- 3) `_mapa_casca_20260902`: tabela de apoio da fusão de casos-fantasma de
--    02/09 (casca_id, gemea_id, nome; 19 linhas), criada direto em prod, sem
--    RLS e com authenticated lendo e escrevendo. Ninguém no código usa. Fica
--    só para postgres e service_role.
--
-- Rollback: supabase/rollbacks/20260903410000_sem_login_nao_chama_rpc.rollback.sql
-- Teste:    supabase/tests/sem_login_nao_chama_rpc_test.sql
-- ============================================================================

do $$
declare r record; v_n int := 0;
begin
  for r in
    select p.oid::regprocedure as assinatura
    from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.proname = any (array[
        '_acordo_fecha_com_a_ultima_parcela','_acordo_herda_responsavel_do_aluno','_aluno_segue_dono_do_acordo',
        '_caso_nao_duplica_aluno','_confirmacao_sem_valor_sai_da_fila','_encerramento_so_gestao',
        '_fechar_confirmacao_ao_zerar_saldo','_fila_acordo_fecha_ao_encerrar_acordo','_notificacoes_diretoria_nao_recebe',
        '_pagamento_baixa_pelo_documento','_pagamento_vincula_aluno_por_nome_unico','_pagamentos_baixar_lote',
        '_parcela_guarda_titulo_origem','_parcela_pago_em_automatico','_reabrir_aluno_com_divida_nova',
        '_titulo_quita_com_o_acordo','_trg_aluno_estado_anterior','_trg_desfazer_cartao_tabulacao',
        '_trg_desfazer_cartao_termo','_trg_notif_termo_gov','_trg_recalc_por_vinculo_novo',
        'acoes_massivas_borderos','aluno_contato_adicionar','aluno_contato_invalidar','aluno_contato_revalidar',
        'aluno_contato_tornar_principal','aluno_contatos_sincronizar','aluno_matricula_semestres',
        'alunos_propaga_encerramento_para_caso','calibragem_simular_ano_parelho','dias_uteis',
        'fn_sync_acionamento_alunos_para_casos','prime_cadastro_aplicar','quitar_e_encerrar_caso','sistema_sob_carga',
        'tg_acordo_bloquear_duplicado','tg_aluno_concluir_retorno_adm_link','tg_conf_pagamento_agenda',
        'tg_pagamento_nome_do_operador','whatsapp_cadencia_consumo','whatsapp_cadencia_indicadores',
        'whatsapp_cadencia_registrar_bloqueio','whatsapp_canais_listar','whatsapp_canal_cadencia_salvar',
        'whatsapp_conversas_listar','whatsapp_resumo','whatsapp_supervisao'])
  loop
    execute format('revoke execute on function %s from public, anon', r.assinatura);
    v_n := v_n + 1;
  end loop;
  raise notice 'sem_login_nao_chama_rpc: % funcoes sem EXECUTE para PUBLIC/anon', v_n;
end $$;

do $$
begin
  if to_regclass('public.consulta_financeira_por_aluno') is not null then
    execute 'alter view public.consulta_financeira_por_aluno set (security_invoker = true)';
  end if;
  if to_regclass('public._mapa_casca_20260902') is not null then
    execute 'alter table public._mapa_casca_20260902 enable row level security';
    execute 'revoke all on public._mapa_casca_20260902 from anon, authenticated';
    execute $c$comment on table public._mapa_casca_20260902 is 'Apoio da fusão de casos-fantasma de 02/09/2026 (casca -> gêmea). Só postgres/service_role; nenhuma tela usa.'$c$;
  end if;
end $$;
