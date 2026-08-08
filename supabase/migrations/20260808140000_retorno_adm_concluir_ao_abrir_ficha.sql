-- Regra de negocio (decisao Amanda 2026-08-08): o card "Link pronto p/ envio"
-- deve sumir do topo assim que o operador ABRE a ficha do aluno.
--
-- Motivo: os operadores enviam o link por fora (WhatsApp) e nao registram no
-- CRM (nao clicam "Link enviado ao aluno"), entao nao existe sinal de envio e o
-- retorno ficava pendente para sempre. Abrir a ficha = o operador viu que o link
-- esta pronto -> conclui o retorno.
--
-- retorno_adm_visualizar ja e chamada ao abrir a ficha (PainelCarteira.abrirModal).
-- Passa a tambem concluir os retornos de link pendentes daquele aluno.

create or replace function public.retorno_adm_visualizar(p_id bigint)
 returns void
 language plpgsql
 security definer
 set search_path to 'public', 'auth'
as $function$
declare
  v_aluno uuid;
  v_afetados int;
begin
  -- Marca visualizacao (comportamento original) e captura o aluno do retorno.
  update public.retornos_adm
    set visualizado_em = coalesce(visualizado_em, now()),
        visualizado_por = coalesce(visualizado_por, auth.email())
    where id = p_id
      and (lower(operador_destino_email) = lower(auth.email())
           or public.perfil_do_usuario_atual() in ('gerencia','administrativo','supervisor'))
    returning aluno_id into v_aluno;

  if v_aluno is null then
    return; -- sem permissao ou id inexistente
  end if;

  -- Conclui os retornos de "link pronto" pendentes deste aluno (abriu a ficha).
  update public.retornos_adm
    set status_tratamento = 'CONCLUIDO', concluido_em = now(), concluido_por = auth.email()
    where aluno_id = v_aluno
      and origem = 'links_pagamento'
      and resultado_adm = 'LINK_PRONTO_PARA_ENVIO'
      and status_tratamento in ('PENDENTE','EM_TRATAMENTO');
  get diagnostics v_afetados = row_count;

  if v_afetados > 0 then
    insert into public.aluno_movimentacoes(
      aluno_id, tipo, descricao, status_anterior, status_novo,
      registrado_por_nome, registrado_por_email, registrado_em
    ) values (
      v_aluno, 'RETORNO_ADM_CONCLUIDO',
      'Retorno do ADM concluído: operador abriu a ficha (link pronto visualizado).',
      'LINK_PRONTO_PARA_ENVIO', 'LINK_PRONTO_PARA_ENVIO',
      'Sistema (Retorno ADM)', auth.email(), now()
    );
  end if;
end $function$;

-- Backfill: os 10 restantes ja foram enviados na pratica (confirmado Amanda).
update public.retornos_adm r
  set status_tratamento = 'CONCLUIDO',
      concluido_em = coalesce(r.concluido_em, now()),
      concluido_por = coalesce(r.concluido_por, 'sistema (backfill enviados por fora)')
  where r.origem = 'links_pagamento'
    and r.resultado_adm = 'LINK_PRONTO_PARA_ENVIO'
    and r.status_tratamento in ('PENDENTE','EM_TRATAMENTO');
