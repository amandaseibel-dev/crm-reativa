-- GIRO DE CARTEIRA (GIRO_2026): desativar a execucao, sem mexer no historico.
--
-- CONTEXTO. O giro foi rodado uma vez, em 10/09/2026 (simulacao
-- c7c49f02-6e85-436b-a606-8f27945f8334, 4.218 casos efetivados). Ele e o unico
-- caminho da calibragem que monta o pool e retira caso do operador SEM olhar a
-- janela dos 10 dias -- e, pelo que ficou decidido, nao havera novo giro.
--
-- Em vez de ensinar a fidelizacao ao giro (logica operacional nova para algo
-- que nao vai rodar), as duas portas passam a recusar a chamada:
--   * calibragem_simular_giro_2026        -- nao cria simulacao nova;
--   * calibragem_executar_giro_lote_impl  -- nao executa nenhuma simulacao,
--     nem as que ja existem.
-- `calibragem_executar_giro_lote` (o wrapper com disjuntor) chama a _impl, entao
-- fica travado junto.
--
-- POR QUE ASSIM, e nao por revoke: tirar EXECUTE de `authenticated` nao impede a
-- chamada por service_role nem pelo SQL Editor, e ja nos custou caro derrubar
-- tela da propria gestao com revoke. Uma recusa explicita dentro da funcao vale
-- para qualquer chamador, diz o motivo em portugues e volta atras com o rollback.
--
-- O QUE ESTA MIGRATION NAO FAZ: nao apaga nem altera calibragem_simulacoes,
-- calibragem_auditoria ou qualquer caso do giro de 10/09; nao mexe em ACL; nao
-- toca no desfazer (calibragem_desfazer_nivelamento_lote), que continua
-- disponivel caso um dia se decida devolver algum caso.

do $mig$
declare
  v_def text := pg_get_functiondef('public.calibragem_simular_giro_2026(jsonb)'::regprocedure);
  v_ancora text := '  if not (public.calibragem_e_gestao() or auth.jwt() is null) then
    raise exception ''Sem permissão para simular o giro de carteira.'';
  end if;';
  v_novo text := '  -- GIRO_DESATIVADO em 29/09/2026: nao havera novo giro de carteira.
  raise exception ''Giro de carteira desativado. Nenhuma simulacao nova de GIRO_2026 e criada; o historico de 10/09 continua intacto.''
    using errcode = ''42501'';
  if not (public.calibragem_e_gestao() or auth.jwt() is null) then
    raise exception ''Sem permissão para simular o giro de carteira.'';
  end if;';
begin
  if position('GIRO_DESATIVADO' in v_def) > 0 then
    raise notice 'calibragem_simular_giro_2026 ja esta desativada; nada a fazer.';
  else
    if position(v_ancora in v_def) = 0 then
      raise exception 'ancora nao encontrada em calibragem_simular_giro_2026';
    end if;
    execute replace(v_def, v_ancora, v_novo);
  end if;
end $mig$;

do $mig$
declare
  v_def text := pg_get_functiondef('public.calibragem_executar_giro_lote_impl(uuid,integer)'::regprocedure);
  v_ancora text := '  if not (public.calibragem_e_gestao() or auth.jwt() is null) then
    raise exception ''Sem permissão para executar o giro de carteira.'';
  end if;';
  v_novo text := '  -- GIRO_DESATIVADO em 29/09/2026: nao havera novo giro de carteira.
  raise exception ''Giro de carteira desativado. Nenhuma simulacao de GIRO_2026 e executada; o historico de 10/09 continua intacto.''
    using errcode = ''42501'';
  if not (public.calibragem_e_gestao() or auth.jwt() is null) then
    raise exception ''Sem permissão para executar o giro de carteira.'';
  end if;';
begin
  if position('GIRO_DESATIVADO' in v_def) > 0 then
    raise notice 'calibragem_executar_giro_lote_impl ja esta desativada; nada a fazer.';
  else
    if position(v_ancora in v_def) = 0 then
      raise exception 'ancora nao encontrada em calibragem_executar_giro_lote_impl';
    end if;
    execute replace(v_def, v_ancora, v_novo);
  end if;
end $mig$;
