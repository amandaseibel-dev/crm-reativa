create or replace function public.desvincular_titulos_acordo(p_titulo_ids uuid[])
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
  v_email text := lower(coalesce(auth.email(),''));
  v_n int;
  v_m int;
  v_travados jsonb;
begin
  if v_email = '' then return jsonb_build_object('ok',false,'erro','NAO_AUTENTICADO'); end if;

  -- PORTÃO NOVO. Desfazer vínculo é decisão da mesma gestão que o criou
  -- (`vincular_titulos_acordo_gestao` já exigia isto), ou da diretoria.
  -- `coalesce(..., false)`: `NULL and ...` não é TRUE e passaria adiante com
  -- autoria nula (lição dos PR #727/#729).
  if not coalesce(public.usuario_e_gestao(), false)
     and not coalesce(public.usuario_e_diretoria(), false)
     and coalesce(auth.role(),'') <> 'service_role' then
    raise exception 'Desvincular mensalidade de acordo e decisao da gestao financeira ou da diretoria.'
      using errcode = '42501';
  end if;

  if p_titulo_ids is null or array_length(p_titulo_ids,1) is null then
    return jsonb_build_object('ok',false,'erro','SEM_TITULOS');
  end if;

  -- GUARDA NOVA. Título quitado, liquidado na origem ou encerrado
  -- administrativamente não sai por aqui: esta função força ABERTO sem olhar
  -- lastro nenhum. Quem retira atribuição de título quitado é a E7, que exige
  -- a prova de que o acordo não cobriu aquela mensalidade.
  select jsonb_agg(jsonb_build_object('titulo_id', t.id, 'documento', t.documento,
                                      'situacao', t.situacao, 'status', t.status,
                                      'origem_liquidacao', t.origem_liquidacao,
                                      'origem_encerramento', t.origem_encerramento))
    into v_travados
    from public.acordos_titulos t
   where t.id = any(p_titulo_ids)
     and (upper(coalesce(t.situacao,'')) = 'PAGO'
          or lower(coalesce(t.status,'')) in ('quitada','paga')
          or coalesce(t.origem_liquidacao,'') <> ''
          or t.origem_encerramento is not null);
  if v_travados is not null then
    return jsonb_build_object('ok', false, 'erro', 'TITULO_QUITADO_USE_ATRIBUICAO_REMOVER',
      'detalhe', 'mensalidade quitada ou com marca de liquidacao nao volta a ABERTO por aqui; '
              || 'use titulo_atribuicao_remover, que exige prova de ausencia de cobertura',
      'titulos', v_travados);
  end if;

  -- Volta a mensalidade para ABERTO (conta de novo no total do aluno).
  -- ANTES gravava status='vinculada' aqui, produzindo a combinacao incoerente
  -- (ABERTO + vinculada + sem vinculo) que dobrava a divida e travava a tela.
  update public.acordos_titulos
     set acordo_id = null, situacao = 'ABERTO', status = 'em_aberto',
         vinculado_em = null, vinculado_por = null, atualizado_em = now()
   where id = any(p_titulo_ids);
  get diagnostics v_n = row_count;

  -- ERA UM DELETE. A linha do vínculo é a cadeia que a guarda de re-acordo de
  -- `titulo_reavaliar` lê, inclusive quando inativa: apagá-la cega a guarda.
  -- Desativar diz a mesma coisa e não perde o histórico.
  update public.acordo_titulo_vinculo
     set ativo = false,
         motivo_desvinculo = 'desvinculado na ficha em '
           || to_char(now() at time zone 'America/Sao_Paulo', 'DD/MM/YYYY')
           || ' por ' || v_email
   where titulo_id = any(p_titulo_ids)
     and coalesce(ativo, true);
  get diagnostics v_m = row_count;

  insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
  values (v_email, 'DESVINCULOU_TITULOS_ACORDO', 'acordos_titulos', null,
          jsonb_build_object('qtd', v_n, 'titulo_ids', p_titulo_ids,
                             'vinculos_desativados', v_m, 'vinculos_apagados', 0));

  return jsonb_build_object('ok', true, 'desvinculados', v_n, 'vinculos_desativados', v_m);
end;
$fn$;

comment on function public.desvincular_titulos_acordo(uuid[]) is
  'Solta mensalidade NEGOCIADO de acordo ATIVO (uso da ficha). Desde 26/10/2026: portao de gestao ou diretoria, DESATIVA o vinculo em vez de apagar, e RECUSA titulo quitado ou com marca de liquidacao/encerramento -- esse caso e titulo_atribuicao_remover (E7), que exige prova de ausencia de cobertura.';

revoke all on function public.desvincular_titulos_acordo(uuid[]) from public;
revoke all on function public.desvincular_titulos_acordo(uuid[]) from anon;
grant execute on function public.desvincular_titulos_acordo(uuid[]) to authenticated;
grant execute on function public.desvincular_titulos_acordo(uuid[]) to service_role;
