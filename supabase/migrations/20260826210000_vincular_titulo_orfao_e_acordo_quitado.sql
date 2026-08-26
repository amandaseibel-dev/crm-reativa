-- Vincular título: liberar o órfão negociado e o acordo já pago.
--
-- Amanda, 26/08/2026: "não consigo vincular as parcelas joao paulo gemelli",
-- "precisa liberar" e "quero a possibilidade de incluir mensalidades no acordo
-- já pago".
--
-- DOIS CASOS TRAVADOS, uma função só.
--
-- 1) TÍTULO NEGOCIADO ÓRFÃO. O título foi marcado NEGOCIADO, o saldo em aberto
--    foi zerado, e o vínculo com o acordo nunca ficou gravado (`acordo_id`
--    nulo). A regra recusava por "sem saldo em aberto": não dá para vincular,
--    não dá para cobrar, não pertence a acordo nenhum.
--
--    São 20 títulos, 9 alunos, R$ 16.585,22 de valor original -- e 6 desses 9
--    alunos são os MESMOS da lista de acordo duplicado. O título foi negociado
--    contra um dos gêmeos e o vínculo se perdeu quando o acordo errado saiu de
--    cena. É rastro de duplicação.
--
--    Agora: saldo zerado não bloqueia QUANDO o título já está NEGOCIADO e sem
--    acordo. Nesse estado ele não é cobrado de ninguém; travá-lo não protege
--    nada, só impede o conserto.
--
-- 2) ACORDO JÁ PAGO. O aluno quitou, mas as mensalidades que aquele acordo
--    cobria continuam soltas, aparecendo como dívida de quem não deve mais
--    nada. A função recusava qualquer acordo não-ATIVO.
--
--    QUITADO   -> o dinheiro entrou; prender a mensalidade registra a verdade.
--                 LIBERADO.
--    CANCELADO -> a dívida VOLTOU para cobrança; prender título nele esconderia
--                 dívida viva. CONTINUA BLOQUEADO.
--
-- Vincular não movimenta dinheiro: não cria baixa, não marca parcela como paga,
-- não mexe em saldo. Só diz a que acordo aquele título pertence.
--
-- O QUE CONTINUA BLOQUEADO, sem exceção: título de outro acordo, título de
-- outro aluno, status pago/quitado/cancelado/vinculada, DUPLICADA, e saldo
-- zerado SEM ser negociado (esse simplesmente não deve nada).
--
-- Provado em produção: o Gemelli, que era o caso travado, passou a vincular os
-- 5 títulos (teste desfeito -- o vínculo real é feito na tela).

create or replace function public.vincular_titulos_acordo(p_titulo_ids uuid[], p_acordo_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_email text := lower(coalesce(auth.email(),''));
  v_aluno_acordo uuid;
  v_status_acordo text;
  v_bloqueados uuid[];
  v_n int;
begin
  if v_email = '' then return jsonb_build_object('ok',false,'erro','NAO_AUTENTICADO'); end if;
  if p_acordo_id is null then return jsonb_build_object('ok',false,'erro','ACORDO_NAO_ENCONTRADO'); end if;
  if p_titulo_ids is null or array_length(p_titulo_ids,1) is null then
    return jsonb_build_object('ok',false,'erro','SEM_TITULOS');
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_acordo_id::text, 0));

  select aluno_id, upper(coalesce(status,'')) into v_aluno_acordo, v_status_acordo
  from public.acordos where id = p_acordo_id;
  if v_aluno_acordo is null then return jsonb_build_object('ok',false,'erro','ACORDO_NAO_ENCONTRADO'); end if;

  -- Acordo cancelado devolveu a divida para cobranca: prender titulo nele
  -- esconderia divida viva. Quitado pode: registra que aquela divida foi paga
  -- por este acordo.
  if v_status_acordo = 'CANCELADO' then
    return jsonb_build_object('ok',false,'erro','acordo_cancelado_operacao_nao_permitida');
  elsif v_status_acordo not in ('ATIVO','QUITADO') then
    return jsonb_build_object('ok',false,'erro','ACORDO_NAO_ATIVO');
  end if;

  perform 1 from public.acordos_titulos where id = any(p_titulo_ids) for update;

  select array_agg(t.id) into v_bloqueados
  from public.acordos_titulos t
  where t.id = any(p_titulo_ids)
    and not (
          t.aluno_id = v_aluno_acordo
      and t.acordo_id is null
      and lower(coalesce(t.status,'')) not in
            ('vinculada','quitada','quitado','paga','pago','cancelada','cancelado')
      and upper(coalesce(t.situacao,'')) <> 'DUPLICADA'
      and (
            coalesce(t.valor_em_aberto, t.saldo_corrigido, t.valor_original, 0) > 0
        -- Já negociado e sem acordo: órfão. Não está sendo cobrado de ninguém,
        -- então travá-lo não protege nada -- só impede o conserto.
        or upper(coalesce(t.situacao,'')) = 'NEGOCIADO'
      )
    );

  if v_bloqueados is not null and array_length(v_bloqueados,1) > 0 then
    return jsonb_build_object('ok',false,'erro','PARCELAS_INELEGIVEIS','bloqueados', to_jsonb(v_bloqueados));
  end if;

  update public.acordos_titulos t
     set acordo_id = p_acordo_id, situacao = 'NEGOCIADO', status = 'vinculada',
         vinculado_em = now(), vinculado_por = v_email, atualizado_em = now()
   where t.id = any(p_titulo_ids) and t.aluno_id = v_aluno_acordo;
  get diagnostics v_n = row_count;

  insert into public.acordo_titulo_vinculo (acordo_id, titulo_id, ativo, vinculado_por, criado_em)
  select p_acordo_id, t.id, true, v_email, now()
  from public.acordos_titulos t
  where t.id = any(p_titulo_ids) and t.aluno_id = v_aluno_acordo
    and not exists (select 1 from public.acordo_titulo_vinculo v where v.titulo_id = t.id);

  insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
  values (v_email, 'VINCULOU_TITULOS_ACORDO', 'acordos_titulos', p_acordo_id,
          jsonb_build_object('acordo_id', p_acordo_id, 'qtd', v_n,
                             'status_acordo', v_status_acordo, 'titulo_ids', p_titulo_ids));

  return jsonb_build_object('ok', true, 'vinculados', v_n, 'acordo_id', p_acordo_id,
                            'status_acordo', v_status_acordo);
end;
$function$;

comment on function public.vincular_titulos_acordo(uuid[], uuid) is
  'Vincula titulos a um acordo ATIVO ou QUITADO. CANCELADO segue bloqueado: ele devolveu a divida para cobranca e prender titulo nele esconderia divida viva. Saldo zerado nao bloqueia quando o titulo ja esta NEGOCIADO e sem acordo (orfao de duplicacao). Continua bloqueado: titulo de outro acordo ou de outro aluno, pago/quitado/cancelado/vinculada, DUPLICADA, e saldo zerado sem ser negociado. Vincular nao movimenta dinheiro.';
