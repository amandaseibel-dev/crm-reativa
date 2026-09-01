-- Amanda, 31/08: "novo acordo cancelado criou parcela" / "ta criando parcela ainda".
--
-- Cancelar acordo era feito pela tela em cinco chamadas soltas, sem transacao
-- e na ordem errada: o vinculo era APAGADO antes do gatilho poder le-lo, e as
-- parcelas eram canceladas depois. Quando um passo falhava no meio, sobrava
-- acordo CANCELADO com parcela viva -- a parcela seguia cobrando e voltava na
-- ficha do aluno (o caso da Viviane Onofre, parcela de R$ 11 mil).
--
-- Aqui tudo acontece numa transacao so, na ordem que o gatilho precisa:
-- 1) status do acordo (vinculo ainda no lugar), 2) titulos, 3) parcelas,
-- 4) vinculo desativado (nunca apagado), 5) recalculo por ultimo.
--
-- Ver [[cancelar-acordo-deixava-parcela-viva]].

create or replace function public.acordo_cancelar(p_acordo_id uuid, p_motivo text default null)
returns jsonb language plpgsql security definer
set search_path to 'public' set statement_timeout to '60s'
as $function$
declare
  v_aluno_id uuid; v_status text;
  v_parcelas int := 0; v_devolvidos int := 0;
  v_boleto_cancelado int := 0; v_vinculos int := 0;
begin
  select a.aluno_id, upper(coalesce(a.status,'')) into v_aluno_id, v_status
    from public.acordos a where a.id = p_acordo_id for update;

  if not found then
    raise exception 'Acordo nao encontrado.' using errcode = 'P0002';
  end if;
  if v_status = 'CANCELADO' then
    return jsonb_build_object('ok', true, 'ja_estava_cancelado', true);
  end if;
  if v_status = 'QUITADO' then
    raise exception 'Acordo ja esta QUITADO -- nao pode ser cancelado.' using errcode = '22000';
  end if;

  -- 1) o acordo muda de status PRIMEIRO, com o vinculo ainda no lugar.
  update public.acordos set status = 'CANCELADO', saldo = 0, atualizado_em = now()
   where id = p_acordo_id;

  -- 2) titulos que o gatilho devolveu ficam com o status coerente
  update public.acordos_titulos t set status = 'em_aberto', atualizado_em = now()
    from public.acordo_titulo_vinculo v
   where v.titulo_id = t.id and v.acordo_id = p_acordo_id and coalesce(v.ativo, true)
     and upper(coalesce(t.situacao,'')) = 'ABERTO' and coalesce(t.status,'') <> 'em_aberto';
  get diagnostics v_devolvidos = row_count;

  select count(*) into v_boleto_cancelado
    from public.acordos_titulos t join public.acordo_titulo_vinculo v on v.titulo_id = t.id
   where v.acordo_id = p_acordo_id and coalesce(t.tipo_boleto,'') = 'Acordo'
     and upper(coalesce(t.situacao,'')) = 'CANCELADA';

  -- 3) as parcelas do acordo morto param de contar.
  update public.parcelas set status = 'CANCELADA', atualizado_em = now()
   where acordo_id = p_acordo_id and status <> 'PAGO' and status <> 'CANCELADA';
  get diagnostics v_parcelas = row_count;

  -- 4) so agora o vinculo sai -- desativado, nao apagado.
  update public.acordo_titulo_vinculo set ativo = false
   where acordo_id = p_acordo_id and coalesce(ativo, true);
  get diagnostics v_vinculos = row_count;

  -- 5) recalculo por ULTIMO, com tudo ja escrito.
  perform public.recalcular_situacao_aluno(v_aluno_id);

  return jsonb_build_object('ok', true, 'aluno_id', v_aluno_id,
    'parcelas_canceladas', v_parcelas, 'titulos_devolvidos', v_devolvidos,
    'vinculos_desativados', v_vinculos, 'boleto_do_acordo_cancelado', v_boleto_cancelado);
end;
$function$;

revoke all on function public.acordo_cancelar(uuid, text) from public, anon;
grant execute on function public.acordo_cancelar(uuid, text) to authenticated, service_role;
