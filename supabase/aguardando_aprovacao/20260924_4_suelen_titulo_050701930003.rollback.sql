-- ============================================================================
-- ROLLBACK do arquivo 4 (caso Suelen) -- por ID, contra o ESTADO DEIXADO
-- ============================================================================
-- Serve para as duas opcoes: le `opcao_aplicada` no backup e desfaz o que
-- aquela opcao fez. Titulo: caa99e1e-4f70-48c6-9a37-0993e75fa306 (doc 050701930003).
--
-- ATENCAO: reverter a opcao 1 ou a 2 RESTAURA a dupla contagem de R$ 428,72 em
-- `saude_carteira_panorama`. So faz sentido se a opcao escolhida se mostrar
-- errada.
--
-- POR QUE A VERSAO ANTERIOR NAO SERVIA
-- Ela conferia apenas se o vinculo estava no 3528 e depois restaurava o titulo
-- sem olhar mais nada. Bastava alguem ter reescrito situacao, motivo, valor ou
-- proveniencia entre a correcao e o rollback para o trabalho ser apagado em
-- silencio. E o ramo da opcao 2 restaurava sem conferir nada alem de
-- `situacao = 'DUPLICADA'`.
--
-- O QUE ESTA VERSAO EXIGE
--   (1) o backup existe E tem a fotografia posterior (`*_pos`, `audit_log_id_pos`,
--       `opcao_aplicada`). Sem isso, ABORTA -- nao adivinha;
--   (2) igualdade campo a campo com o que a correcao deixou, incluindo o
--       conjunto de vinculos (`vinculos_pos`);
--   (3) nenhum evento em `audit_log` com `id > audit_log_id_pos` tocando campo
--       relevante;
--   (4) nenhuma marca de liquidacao independente que tenha aparecido depois.
--
-- Como e um titulo so, divergencia aborta a transacao inteira com o motivo
-- exato -- nao ha "recusar so este" quando este e o unico.
-- ============================================================================

begin;

do $$
declare
  v_t public.acordos_titulos;
  v_b record;
  v_vinc_hoje jsonb;
  v_audit_hoje bigint;
  v_id uuid := 'caa99e1e-4f70-48c6-9a37-0993e75fa306';
begin
  -- (1) backup com fotografia posterior
  select * into v_b from public._backup_saneamento_suelen_20260924 where titulo_id = v_id;
  if not found then
    raise exception 'ABORTA: backup do caso Suelen nao encontrado -- nada foi aplicado, ou o backup foi descartado';
  end if;
  if v_b.registro_pos is null or v_b.audit_log_id_pos is null
     or coalesce(v_b.opcao_aplicada,'DEFINA_A_OPCAO') = 'DEFINA_A_OPCAO' then
    raise exception 'ABORTA: o backup nao tem fotografia posterior completa (registro_pos / audit_log_id_pos / opcao_aplicada). A correcao foi aplicada sem o bloco 5 do arquivo 4. Sem ela nao ha com o que comparar -- reverta a mao.';
  end if;

  select * into v_t from public.acordos_titulos where id = v_id;
  if not found then
    raise exception 'ABORTA: o titulo nao existe mais';
  end if;

  -- (2) igualdade campo a campo com o estado deixado
  if v_t.situacao is distinct from v_b.situacao_pos then
    raise exception 'ABORTA: situacao mudou depois da correcao -- deixei %, esta %', coalesce(v_b.situacao_pos,'(nulo)'), coalesce(v_t.situacao,'(nulo)');
  end if;
  if v_t.status is distinct from v_b.status_pos then
    raise exception 'ABORTA: status mudou depois da correcao -- deixei %, esta %', coalesce(v_b.status_pos,'(nulo)'), coalesce(v_t.status,'(nulo)');
  end if;
  if v_t.acordo_id is distinct from v_b.acordo_id_pos then
    raise exception 'ABORTA: acordo_id mudou depois da correcao';
  end if;
  if v_t.motivo_ajuste is distinct from v_b.motivo_ajuste_pos then
    raise exception 'ABORTA: motivo_ajuste foi reescrito depois da correcao';
  end if;
  if v_t.quitacao_origem is distinct from v_b.quitacao_origem_pos
     or v_t.quitacao_origem_acordo_id is distinct from v_b.quitacao_origem_acordo_id_pos then
    raise exception 'ABORTA: a proveniencia da quitacao mudou depois da correcao';
  end if;
  if v_t.saldo_corrigido is distinct from v_b.saldo_corrigido_pos
     or v_t.valor_em_aberto is distinct from v_b.valor_em_aberto_pos then
    raise exception 'ABORTA: o VALOR do titulo mudou depois da correcao -- nao restaurar sem conferir';
  end if;

  -- o conjunto de vinculos tambem: a opcao 1 mexe nele
  select coalesce(jsonb_agg(to_jsonb(v) order by v.acordo_id), '[]'::jsonb)
    into v_vinc_hoje
    from public.acordo_titulo_vinculo v where v.titulo_id = v_id;
  if v_vinc_hoje is distinct from v_b.vinculos_pos then
    raise exception 'ABORTA: o conjunto de vinculos mudou depois da correcao -- alguem revinculou, conferir a mao';
  end if;

  -- (3) evento posterior a marca-d'agua
  select max(l.id) into v_audit_hoje from public.audit_log l
   where l.tabela = 'acordos_titulos' and l.registro_id = v_id::text;
  if exists (
    select 1 from public.audit_log l
     where l.tabela = 'acordos_titulos' and l.registro_id = v_id::text
       and l.id > v_b.audit_log_id_pos
       and (l.dados_depois->'situacao'                  is distinct from l.dados_antes->'situacao'
         or l.dados_depois->'status'                    is distinct from l.dados_antes->'status'
         or l.dados_depois->'acordo_id'                 is distinct from l.dados_antes->'acordo_id'
         or l.dados_depois->'motivo_ajuste'             is distinct from l.dados_antes->'motivo_ajuste'
         or l.dados_depois->'quitacao_origem'           is distinct from l.dados_antes->'quitacao_origem'
         or l.dados_depois->'quitacao_origem_acordo_id' is distinct from l.dados_antes->'quitacao_origem_acordo_id'
         or l.dados_depois->'saldo_corrigido'           is distinct from l.dados_antes->'saldo_corrigido'
         or l.dados_depois->'valor_em_aberto'           is distinct from l.dados_antes->'valor_em_aberto'
         or l.dados_depois->'origem_liquidacao'         is distinct from l.dados_antes->'origem_liquidacao'
         or l.dados_depois->'origem_encerramento'       is distinct from l.dados_antes->'origem_encerramento'))
  then
    raise exception 'ABORTA: houve evento posterior no audit_log tocando campo relevante (marca-d''agua %, hoje %)', v_b.audit_log_id_pos, v_audit_hoje;
  end if;

  -- (4) liquidacao independente que apareceu depois
  if v_t.origem_liquidacao is not null or v_t.origem_encerramento is not null then
    raise exception 'ABORTA: o titulo ganhou marca de liquidacao/encerramento depois da correcao';
  end if;
  if exists (select 1 from public.pagamentos pg
              where regexp_replace(coalesce(pg.titulo_numero,''),'\D','','g') = '50701930003') then
    raise exception 'ABORTA: apareceu pagamento proprio para o boleto 50701930003 -- nao restaurar por cima';
  end if;
  if exists (select 1 from public.conferencia_pagamentos cp
              where regexp_replace(coalesce(cp.titulo_numero,''),'\D','','g') = '50701930003') then
    raise exception 'ABORTA: apareceu registro em conferencia_pagamentos para o boleto 50701930003';
  end if;
  if exists (select 1 from public.solicitacoes_confirmacao_pagamento s where s.titulo_id = v_id) then
    raise exception 'ABORTA: apareceu solicitacao de confirmacao de pagamento para este titulo';
  end if;

  raise notice 'conferencia OK -- opcao aplicada: %, marca-d''agua do audit_log: %', v_b.opcao_aplicada, v_b.audit_log_id_pos;
end $$;

-- ---------------------------------------------------------------------------
-- A RESTAURACAO -- o vinculo volta ao 3609 SO se a opcao 1 o tiver movido
-- ---------------------------------------------------------------------------
update public.acordo_titulo_vinculo v
   set acordo_id = '2d310307-b610-45ab-9d02-2713cde83ad7'   -- 3609
 where v.titulo_id = 'caa99e1e-4f70-48c6-9a37-0993e75fa306'
   and v.acordo_id = '1e904398-dc1c-459c-956b-fdce05248f97' -- 3528
   and exists (select 1 from public._backup_saneamento_suelen_20260924
                where titulo_id = 'caa99e1e-4f70-48c6-9a37-0993e75fa306'
                  and opcao_aplicada in ('OPCAO_1_MOVER_VINCULO','OPCAO_1_E_2'));

update public.acordos_titulos t
   set situacao = b.situacao_anterior,
       status = b.status_anterior,
       acordo_id = b.acordo_id_anterior,
       motivo_ajuste = b.motivo_ajuste_anterior,
       atualizado_em = now()
  from public._backup_saneamento_suelen_20260924 b
 where t.id = b.titulo_id
   and t.id = 'caa99e1e-4f70-48c6-9a37-0993e75fa306';

-- ---------------------------------------------------------------------------
-- CONFERENCIA FINAL -- voltou ao estado anterior exato?
-- ---------------------------------------------------------------------------
do $$
declare v_b record; v_t public.acordos_titulos; v_vinc jsonb;
begin
  select * into v_b from public._backup_saneamento_suelen_20260924
   where titulo_id = 'caa99e1e-4f70-48c6-9a37-0993e75fa306';
  select * into v_t from public.acordos_titulos
   where id = 'caa99e1e-4f70-48c6-9a37-0993e75fa306';

  if v_t.situacao is distinct from v_b.situacao_anterior
     or v_t.status is distinct from v_b.status_anterior
     or v_t.acordo_id is distinct from v_b.acordo_id_anterior
     or v_t.motivo_ajuste is distinct from v_b.motivo_ajuste_anterior then
    raise exception 'ABORTA: o titulo nao voltou ao estado exato do backup';
  end if;

  if v_b.opcao_aplicada in ('OPCAO_1_MOVER_VINCULO','OPCAO_1_E_2') then
    select coalesce(jsonb_agg(to_jsonb(v) order by v.acordo_id), '[]'::jsonb)
      into v_vinc from public.acordo_titulo_vinculo v
     where v.titulo_id = 'caa99e1e-4f70-48c6-9a37-0993e75fa306';
    if v_vinc is distinct from v_b.vinculos_anteriores then
      raise exception 'ABORTA: os vinculos nao voltaram ao conjunto anterior exato';
    end if;
  end if;

  raise notice 'REVERTIDO (%). A dupla contagem de R$ 428,72 voltou em saude_carteira_panorama.', v_b.opcao_aplicada;
end $$;

commit;

-- O backup NAO e derrubado: e a prova do que foi feito.
--   drop table public._backup_saneamento_suelen_20260924;
