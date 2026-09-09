-- ACORDO CANCELADO DEVOLVE A MENSALIDADE.
--
-- 09/09/2026: 53 titulos de 33 alunos, R$ 81.041,60, estavam presos como
-- 'vinculada'/'NEGOCIADO' em acordos CANCELADOS -- o mais antigo desde 24/07.
-- A divida sumiu da carteira e ninguem estava cobrando.
--
-- A LOGICA DE DEVOLUCAO JA EXISTIA E ESTAVA CERTA: titulo_situacao_por_vinculo
-- devolve o titulo para ABERTO/em_aberto quando nao ha vinculo ativo com acordo
-- nao-cancelado. O furo era QUANDO ela roda: so no gatilho de
-- acordo_titulo_vinculo. Cancelar o acordo por qualquer caminho que nao mexa
-- nessa tabela -- importacao, update direto, telas antigas -- deixava o titulo
-- para tras em silencio. acordo_cancelar() desativa o vinculo e por isso
-- funcionava; mas dos 384 acordos cancelados, so 34 tem linha de vinculo, e
-- NENHUMA estava inativa.
--
-- A correcao tira a regra de dentro do gatilho e a coloca numa funcao propria,
-- chamada pelos DOIS lados: quando o vinculo muda E quando o status do acordo
-- muda. Mesma regra, dois gatilhos -- nada de logica duplicada.
--
-- A composicao do acordo NAO se perde: a linha de acordo_titulo_vinculo
-- continua la depois do cancelamento, e a ficha le dela (src/utils/origemDoAcordo.js).

create or replace function public.titulo_reavaliar(p_titulo uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
  v_situacao text; v_status text;
  v_acordo uuid; v_status_acordo text; v_numero text; v_quitado boolean;
begin
  select situacao, status into v_situacao, v_status
    from public.acordos_titulos where id = p_titulo;
  if not found then return; end if;

  -- Ja paga: nada aqui reabre mensalidade quitada.
  if upper(coalesce(v_situacao,'')) = 'PAGO'
     or lower(coalesce(v_status,'')) in ('quitada','paga') then
    return;
  end if;

  select v.acordo_id, upper(coalesce(a.status,'')), coalesce(a.numero_acordo::text,'')
    into v_acordo, v_status_acordo, v_numero
    from public.acordo_titulo_vinculo v
    join public.acordos a on a.id = v.acordo_id
   where v.titulo_id = p_titulo
     and coalesce(v.ativo, true)
     and upper(coalesce(a.status,'')) not in ('CANCELADO','CANCELADA')
   order by v.criado_em desc nulls last
   limit 1;

  -- Sem acordo vivo: a divida volta a ser cobrada. O vinculo continua na
  -- tabela, entao a composicao do acordo nao se perde.
  if v_acordo is null then
    update public.acordos_titulos
       set situacao = 'ABERTO', status = 'em_aberto',
           acordo_id = null, atualizado_em = now()
     where id = p_titulo
       and (coalesce(situacao,'') <> 'ABERTO'
            or coalesce(status,'') <> 'em_aberto'
            or acordo_id is not null);
    return;
  end if;

  -- Quitado de verdade e acordo sem parcela viva. Acordo marcado QUITADO com
  -- parcela em aberto nao quita mensalidade nenhuma (guarda de 20260831140000).
  -- RENEGOCIADA nao entra aqui: parcela renegociada nao e parcela paga.
  v_quitado := v_status_acordo = 'QUITADO'
    and not exists (
      select 1 from public.parcelas p
       where p.acordo_id = v_acordo
         and upper(coalesce(p.status,'')) not in ('PAGO','CANCELADA','RENEGOCIADA'));

  if v_quitado then
    update public.acordos_titulos
       set situacao = 'PAGO', status = 'quitada', acordo_id = v_acordo,
           motivo_ajuste = coalesce(motivo_ajuste,'')
             || case when coalesce(motivo_ajuste,'') = '' then '' else ' | ' end
             || 'quitada junto com o acordo ' || v_numero
             || ': a divida desta mensalidade foi negociada nele e o acordo foi pago',
           atualizado_em = now()
     where id = p_titulo;
  else
    update public.acordos_titulos
       set situacao = 'NEGOCIADO', status = 'vinculada',
           acordo_id = v_acordo, atualizado_em = now()
     where id = p_titulo
       and (coalesce(situacao,'') <> 'NEGOCIADO'
            or coalesce(status,'') <> 'vinculada'
            or acordo_id is distinct from v_acordo);
  end if;
end;
$fn$;

comment on function public.titulo_reavaliar(uuid) is
  'Decide se a mensalidade volta a ser cobrada, fica negociada ou fica quitada, olhando os vinculos vivos. Unica regra; chamada pelo gatilho do vinculo e pelo gatilho do status do acordo.';

create or replace function public.titulo_situacao_por_vinculo()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare v_titulo uuid;
begin
  foreach v_titulo in array
    array(select distinct x from unnest(array[new.titulo_id, old.titulo_id]) x where x is not null)
  loop
    perform public.titulo_reavaliar(v_titulo);
  end loop;
  return coalesce(new, old);
end;
$fn$;

-- O ELO QUE FALTAVA: mudou o status do acordo, reavalia os titulos dele.
create or replace function public._acordo_status_reavalia_titulos()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare v_titulo uuid;
begin
  for v_titulo in
    select distinct t.id from public.acordos_titulos t where t.acordo_id = new.id
    union
    select distinct v.titulo_id from public.acordo_titulo_vinculo v where v.acordo_id = new.id
  loop
    perform public.titulo_reavaliar(v_titulo);
  end loop;
  return null;
end;
$fn$;

drop trigger if exists trg_acordo_status_reavalia_titulos on public.acordos;
create trigger trg_acordo_status_reavalia_titulos
  after update of status on public.acordos
  for each row
  when (upper(coalesce(old.status,'')) is distinct from upper(coalesce(new.status,'')))
  execute function public._acordo_status_reavalia_titulos();
