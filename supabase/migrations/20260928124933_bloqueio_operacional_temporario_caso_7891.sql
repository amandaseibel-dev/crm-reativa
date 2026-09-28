begin;

create table if not exists public._backup_bloqueio_operacional_caso_7891_20260928 as
select id, aluno_id, caso_codigo, nao_acionar, observacao_operacional, now() as capturado_em
  from public.casos
 where id = 'e5600cf5-17ba-4d77-856a-9e6d5065b82c';

do $guarda$
declare
  v_caso  uuid := 'e5600cf5-17ba-4d77-856a-9e6d5065b82c';
  v_aluno uuid := 'bd46ef71-be72-47e1-9658-e50ff086197a';
  n int; v_ant boolean; v_obs text; v_dep boolean;
begin
  select count(*) into n from public.casos where aluno_id = v_aluno;
  if n <> 1 then
    raise exception 'ABORTADO: esperado exatamente 1 caso na ficha, encontrado %', n;
  end if;

  select nao_acionar, observacao_operacional into v_ant, v_obs
    from public.casos where id = v_caso and aluno_id = v_aluno and caso_codigo = 7891;
  if not found then
    raise exception 'ABORTADO: divergencia de identidade (caso/ficha/codigo nao conferem)';
  end if;
  if v_ant is true then
    raise exception 'ABORTADO: caso ja esta bloqueado (nao_acionar = true)';
  end if;
  if v_obs is not null then
    raise exception 'ABORTADO: observacao_operacional ja preenchida -- nao sobrescrever';
  end if;

  if not exists (select 1 from public._backup_bloqueio_operacional_caso_7891_20260928 where id = v_caso) then
    raise exception 'ABORTADO: backup do valor anterior nao foi gravado';
  end if;

  update public.casos
     set nao_acionar = true,
         observacao_operacional =
           'BLOQUEIO OPERACIONAL TEMPORARIO (28/09/2026). Motivo: Conferencia de titularidade dos '
           || 'titulos vinculados e solicitacao da composicao documental do acordo 63361. '
           || 'Valor anterior de nao_acionar: false. Desfazer: '
           || 'supabase/rollbacks/bloqueio_operacional_temporario_caso_7891.rollback.sql'
   where id = v_caso;

  select nao_acionar into v_dep from public.casos where id = v_caso;
  if v_dep is not true then
    raise exception 'ABORTADO: o bloqueio nao persistiu';
  end if;

  if exists (select 1 from public.casos c
              where c.id = v_caso
                and (c.saldo_total          is distinct from 7402.87
                  or c.saldo_vencido        is distinct from 3515.31
                  or c.status_atual         is distinct from 'ENCERRADO'
                  or c.status_acionamento   is distinct from 'MENSAGEM ENVIADA'
                  or c.status_financeiro    is distinct from 'ENCERRADO'
                  or c.encerrado_operacional is distinct from false
                  or c.operador_email       is distinct from 'carteira.geral@reativa.local')) then
    raise exception 'ABORTADO: efeito colateral detectado no proprio caso';
  end if;

  if not exists (select 1 from public.acordos
                  where id = 'f008f3b1-a931-40fd-a261-3cff48158dbf'
                    and status = 'ATIVO' and saldo = 5831.32 and qtd_parcelas = 6) then
    raise exception 'ABORTADO: acordo 63361 nao esta intacto';
  end if;

  if (select count(*) from public.parcelas
       where acordo_id = 'f008f3b1-a931-40fd-a261-3cff48158dbf'
         and status in ('A_VENCER','VENCIDA')) <> 6 then
    raise exception 'ABORTADO: parcelas do acordo 63361 alteradas';
  end if;

  if (select count(*) from public.acordos_titulos
       where documento in ('4036151','4036152','4036153','4036154','4036155','4036156','4036157')
         and aluno_id = v_aluno) <> 7 then
    raise exception 'ABORTADO: vinculo dos titulos alterado';
  end if;
end
$guarda$;

commit;