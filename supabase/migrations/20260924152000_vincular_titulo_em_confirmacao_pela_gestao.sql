-- Parcela nao vinculada e parcela DISPONIVEL -- inclusive a que esta em confirmacao.
--
-- Amanda, 24/09/2026: "eu quero como era: as parcelas, se nao foram vinculadas,
-- elas precisam ficar disponiveis para que eu valide e faca o vinculo".
--
-- O QUE ESTAVA ERRADO. A mensalidade que a Conferencia Prime marca
-- EM_CONFIRMACAO nao esta vinculada a acordo nenhum -- `acordo_id` e nulo e nao
-- ha linha em `acordo_titulo_vinculo`. Ainda assim ela nao podia ser vinculada
-- pelo caminho normal: a tela "Vincular a acordo existente" ate a oferecia, mas
-- `vincular_titulos_acordo` batia no gatilho `trg_titulo_em_confirmacao_protegido`,
-- que reescrevia situacao/status/acordo_id de volta e apenas registrava a recusa
-- em `auditoria`. A funcao respondia `ok: true` e nada era vinculado. Desde
-- 20260924135651 a recusa passou a ser um erro explicito -- honesto, mas ainda
-- um nao.
--
-- Resultado pratico: 674 mensalidades (R$ 1.565.480,05) fora do alcance da
-- pessoa que decide, esperando uma prova automatica que a API da Prime nao
-- fornece (docs/integracoes/prime-gaps.md, VERMELHO).
--
-- O QUE MUDA. Um envelope fino em volta da funcao que ja existe:
--
--   1. so gestao financeira (`crm_usuario_pode_quitar_baixar` ou
--      `usuario_e_gestao`) -- a mesma porta das outras decisoes financeiras;
--   2. liga `conferencia_prime.decisao` na PROPRIA transacao, que e a chave que
--      o gatilho de protecao e o guard do vinculo ja reconhecem -- nenhuma
--      trava foi afrouxada, a porta usada e a que sempre existiu;
--   3. chama `public.vincular_titulos_acordo` SEM COPIAR NADA: toda a regra
--      (acordo do mesmo aluno, sem vinculo ativo em outro acordo, re-acordo
--      tudo-ou-nada, estado do titulo seguindo o status do acordo, a prova de
--      um vinculo ativo por mensalidade) continua morando la, num lugar so;
--   4. fecha a decisao pendente da Conferencia Prime como VINCULADO -- senao a
--      mensalidade sairia vinculada e o caso ficaria na fila da conferencia
--      para sempre;
--   5. registra em `auditoria` e na movimentacao do aluno quem vinculou, a
--      qual acordo e por que.
--
-- O QUE NAO MUDA: `vincular_titulos_acordo` nao foi tocada. `prime_conferencia_vincular`
-- tambem nao -- quem preferir decidir pela Conferencia Prime continua igual.

create or replace function public.vincular_titulos_acordo_gestao(
  p_titulo_ids uuid[],
  p_acordo_id  uuid,
  p_motivo     text default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
set statement_timeout to '60s'
as $function$
declare
  v_email     text := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_motivo    text := nullif(btrim(coalesce(p_motivo, '')), '');
  v_res       jsonb;
  v_conf      uuid[];
  v_numero    text;
  v_status    text;
  v_fechadas  int := 0;
  v_t         record;
begin
  if not (coalesce(public.crm_usuario_pode_quitar_baixar(), false)
          or coalesce(public.usuario_e_gestao(), false)) then
    raise exception 'SEM_PERMISSAO: vincular mensalidade a acordo e da gestao financeira.'
      using errcode = '42501';
  end if;

  select coalesce(numero_acordo::text, '?'), upper(coalesce(status, ''))
    into v_numero, v_status
    from public.acordos where id = p_acordo_id;

  -- Quais dos titulos pedidos estao presos na conferencia: so esses precisam da
  -- chave, e so esses terao decisao para fechar depois.
  select array_agg(t.id) into v_conf
    from public.acordos_titulos t
   where t.id = any(coalesce(p_titulo_ids, '{}'::uuid[]))
     and upper(coalesce(t.situacao, '')) = 'EM_CONFIRMACAO';

  -- A porta que o gatilho de protecao e o guard do vinculo ja conhecem. Vale
  -- so nesta transacao.
  perform set_config('conferencia_prime.decisao', 'on', true);
  v_res := public.vincular_titulos_acordo(p_titulo_ids, p_acordo_id);
  perform set_config('conferencia_prime.decisao', 'off', true);

  if not coalesce((v_res->>'ok')::boolean, false) then
    -- A funcao devolve erro sem escrever nada; propagamos como esta, para a
    -- tela mostrar o motivo real (PARCELAS_INELEGIVEIS, REACORDO_PARCIAL...).
    return v_res;
  end if;

  -- A decisao pendente da conferencia fecha junto: a mensalidade acabou de
  -- ganhar dono, entao nao ha mais o que decidir sobre ela.
  if v_conf is not null then
    for v_t in
      select t.id, t.documento, t.aluno_id,
             round(coalesce(t.valor_cobranca_ajustado, t.saldo_corrigido,
                            t.valor_em_aberto, t.valor_original, 0), 2) as valor
        from public.acordos_titulos t
       where t.id = any(v_conf)
    loop
      update public.prime_conferencia_decisao
         set decisao = 'VINCULADO',
             motivo = 'vinculado pela gestao na ficha ao acordo ' || v_numero
                      || coalesce(': ' || v_motivo, ''),
             decidido_por = nullif(v_email, ''), decidido_em = now(),
             acordo_id = p_acordo_id, acordo_numero = v_numero
       where titulo_id = v_t.id and decisao = 'PENDENTE';
      if found then
        v_fechadas := v_fechadas + 1;
      end if;

      insert into public.aluno_movimentacoes
        (aluno_id, tipo, descricao, status_anterior, status_novo,
         registrado_por_nome, registrado_por_email, registrado_em, valor_movimentacao)
      values (v_t.aluno_id::text, 'TITULO_VINCULADO_PELA_GESTAO',
              'Titulo ' || coalesce(v_t.documento, '?') || ' estava em confirmacao e foi vinculado '
                || 'pela gestao ao acordo ' || v_numero || ' (' || coalesce(v_status, '?') || '): '
                || 'a divida passa a viver nas parcelas do acordo.'
                || coalesce(' ' || v_motivo, ''),
              'EM_CONFIRMACAO', upper(coalesce(v_res->>'estado_titulo', '')),
              v_email, v_email, now(), v_t.valor);

      insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
      values (coalesce(nullif(v_email, ''), 'sistema'),
              'TITULO_EM_CONFIRMACAO_VINCULADO_PELA_GESTAO', 'acordos_titulos', v_t.id,
              jsonb_build_object('acordo_id', p_acordo_id, 'acordo_numero', v_numero,
                                 'acordo_status', v_status, 'valor', v_t.valor,
                                 'motivo', v_motivo, 'resultado', v_res));
    end loop;
  end if;

  return v_res || jsonb_build_object('decisoes_fechadas', v_fechadas,
                                     'em_confirmacao', coalesce(cardinality(v_conf), 0));
end;
$function$;

comment on function public.vincular_titulos_acordo_gestao(uuid[], uuid, text) is
  'Vinculo normal de mensalidade a acordo, valendo tambem para a que esta EM_CONFIRMACAO: abre a porta da Conferencia Prime na propria transacao, chama vincular_titulos_acordo (toda a regra continua la) e fecha a decisao pendente como VINCULADO.';

revoke all on function public.vincular_titulos_acordo_gestao(uuid[], uuid, text) from public;
grant execute on function public.vincular_titulos_acordo_gestao(uuid[], uuid, text) to authenticated;
