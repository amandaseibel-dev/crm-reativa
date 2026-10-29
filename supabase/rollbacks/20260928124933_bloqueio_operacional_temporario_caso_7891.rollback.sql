-- DESFAZ o bloqueio operacional temporario aplicado pela versao 20260928124933
-- (caso 7891, ficha bd46ef71-be72-47e1-9658-e50ff086197a).
--
-- NAO e um restore cego. Nao ha PITR neste projeto: todo rollback e backup dos
-- registros afetados + reversao por id exato, SEM apagar o que entrou depois.
--
-- Por isso este arquivo so restaura se o caso ainda estiver EXATAMENTE no estado
-- que o bloqueio deixou. Se alguem mexeu no campo depois -- desbloqueou na mao,
-- escreveu outra observacao operacional, bloqueou de novo por outro motivo --
-- restaurar apagaria essa decisao. Nesse caso ele ABORTA e pede revisao humana.
--
-- Confere, antes de escrever:
--   1. existe exatamente 1 linha no backup, e exatamente 1 caso na ficha;
--   2. identidade: id do caso + aluno_id + caso_codigo 7891;
--   3. estado atual == estado deixado pelo bloqueio (nao_acionar = true E a
--      observacao operacional literal gravada em 28/09);
--   4. o backup guarda o valor anterior esperado (nao_acionar = false).
--
-- NAO toca em titulo, vinculo, acordo, parcela, saldo, pagamento, tabulacao nem
-- data_retorno. Depois de rodar, o D-2 volta a poder gerar normalmente (o indice
-- e parcial em resolvido_em is null, nada fica travado).
--
-- A tabela de backup NAO e apagada aqui, de proposito: ela e a prova do valor
-- anterior e custa 1 linha.

begin;

do $desfaz$
declare
  v_caso  uuid := 'e5600cf5-17ba-4d77-856a-9e6d5065b82c';
  v_aluno uuid := 'bd46ef71-be72-47e1-9658-e50ff086197a';
  v_obs_esperada text :=
    'BLOQUEIO OPERACIONAL TEMPORARIO (28/09/2026). Motivo: Conferencia de titularidade dos '
    || 'titulos vinculados e solicitacao da composicao documental do acordo 63361. '
    || 'Valor anterior de nao_acionar: false. Desfazer: '
    || 'supabase/rollbacks/bloqueio_operacional_temporario_caso_7891.rollback.sql';
  n int; v_atual boolean; v_obs text; v_bkp boolean; v_bkp_obs text;
begin
  -- 1. cardinalidade
  select count(*) into n from public._backup_bloqueio_operacional_caso_7891_20260928;
  if n <> 1 then
    raise exception 'ABORTADO: backup tem % linha(s), esperado exatamente 1', n;
  end if;

  select count(*) into n from public.casos where aluno_id = v_aluno;
  if n <> 1 then
    raise exception 'ABORTADO: ficha tem % caso(s), esperado exatamente 1', n;
  end if;

  -- 2. identidade
  select c.nao_acionar, c.observacao_operacional into v_atual, v_obs
    from public.casos c
   where c.id = v_caso and c.aluno_id = v_aluno and c.caso_codigo = 7891;
  if not found then
    raise exception 'ABORTADO: divergencia de identidade (caso/ficha/codigo nao conferem)';
  end if;

  select b.nao_acionar, b.observacao_operacional into v_bkp, v_bkp_obs
    from public._backup_bloqueio_operacional_caso_7891_20260928 b
   where b.id = v_caso and b.aluno_id = v_aluno;
  if not found then
    raise exception 'ABORTADO: o backup nao corresponde a este caso';
  end if;

  -- 3. estado atual tem de ser o que ESTE bloqueio deixou
  if v_atual is distinct from true then
    raise exception 'ABORTADO: nao_acionar nao esta true (esta %) -- alguem mexeu depois; revisar antes de restaurar', coalesce(v_atual::text,'null');
  end if;
  if v_obs is distinct from v_obs_esperada then
    raise exception 'ABORTADO: observacao_operacional mudou desde o bloqueio -- restaurar apagaria a alteracao posterior; revisar';
  end if;

  -- 4. o backup tem de guardar o valor anterior esperado
  if v_bkp is distinct from false or v_bkp_obs is not null then
    raise exception 'ABORTADO: backup nao contem o estado anterior esperado (false / observacao vazia)';
  end if;

  update public.casos
     set nao_acionar            = v_bkp,
         observacao_operacional = v_bkp_obs
   where id = v_caso;

  if exists (select 1 from public.casos where id = v_caso
              and (nao_acionar is distinct from false or observacao_operacional is not null)) then
    raise exception 'ABORTADO: a restauracao nao persistiu';
  end if;
end
$desfaz$;

commit;
