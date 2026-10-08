-- BACKFILL do historico: aplica a regra de 07/10/2026 aos casos que JA estavam
-- cancelados, suspensos ou com antecipacao antes dela existir.
--
-- Autorizado pela gestao em 08/10/2026 ("incluindo o historico apos validar as
-- parcelas elegiveis"). As migrations anteriores foram PROSPECTIVAS de
-- proposito; este arquivo e o unico que toca dado historico.
--
-- DEPENDE de 20261007210000 (parcela_viva) e 20261007211500 (a regra).
--
-- O QUE FOI MEDIDO EM PRODUCAO EM 08/10/2026, e e o universo elegivel:
--
--   CANCELAMENTO_COBRANCA -- 22 alunos
--     parcelas vivas ....... 0
--     titulos no saldo ..... 17, R$ 130.904,96              -> ENCERRAR
--
--   SUSPENSAO_COBRANCA -- 118 alunos
--     parcelas vivas ....... 13, R$ 258.951,51              -> SUSPENSA
--     titulos no saldo ..... 186 (63 alunos), R$ 462.909,38 -> NAO TOCAR
--
-- Os numeros sao do PORTAO CANONICO (`aluno_bloqueio_administrativo`), que le
-- aluno E caso. Lendo so `alunos`, como a primeira versao deste arquivo fazia,
-- o universo vinha 6 alunos e 3 parcelas (R$ 13.364,19) menor.
--
--   ANTECIPACAO_SEMESTRE -- 0 alunos. Nada a fazer.
--
-- POR QUE OS 185 TITULOS DA SUSPENSAO NAO SAO TOCADOS. Suspensao e TEMPORARIA:
-- a divida continua existindo, so nao se cobra agora. Encerrar o titulo seria
-- trata-la como definitiva e, pior, seria irreversivel -- o encerramento
-- administrativo e terminal por gatilho. O aluno suspenso ja esta fora das
-- filas e da contagem dos 500 por `caso_encerrado_operacional`, que e o que
-- "fora da cobranca" significa. Os R$ 462.348,53 seguem no saldo POR DESENHO.
--
-- O QUE PRESERVA PAGAMENTO REAL, que e a exigencia explicita da gestao:
--   * so parcela que `parcela_viva()` considera cobravel entra. PAGO e PAGA
--     ficam de fora por construcao, nao por lista escrita a mao;
--   * `pago_em`, `origem_baixa`, `origem_baixa_ref`, `origem_baixa_em` e
--     `honorarios` NAO sao escritos em nenhuma linha;
--   * RENEGOCIADA fica de fora, embora `parcela_viva()` a considere cobravel:
--     ela foi renegociada para outro acordo, e marca-la como devolvida
--     contaria a mesma divida duas vezes. Medido: 0 das 10 elegiveis esta
--     RENEGOCIADA, entao a guarda nao muda o resultado -- existe para o caso
--     de o universo mudar entre a medicao e a aplicacao;
--   * acordo CANCELADO/CANCELADA fica de fora (a parcela ja esta resolvida).
--
-- BACKUP ANTES DE ESCREVER. PITR nao esta habilitado neste projeto, entao
-- rollback nao pode ser restore: a reversao e por id exato a partir da tabela
-- de backup criada aqui, que guarda a linha inteira em jsonb.
--
-- ROLLBACK: supabase/rollbacks/20261008090000_backfill_devolvida_suspensa_historico.rollback.sql

-- ---------------------------------------------------------------------------
-- 1. BACKUP
-- ---------------------------------------------------------------------------
create table if not exists public._backup_backfill_efeito_sem_pagamento (
  id uuid primary key default gen_random_uuid(),
  lote text not null,
  tabela text not null,
  registro_id uuid not null,
  aluno_id uuid,
  snapshot jsonb not null,
  criado_em timestamptz not null default now()
);
alter table public._backup_backfill_efeito_sem_pagamento enable row level security;
drop policy if exists _backup_backfill_efeito_deny on public._backup_backfill_efeito_sem_pagamento;
create policy _backup_backfill_efeito_deny
  on public._backup_backfill_efeito_sem_pagamento for all to authenticated, anon
  using (false) with check (false);
create index if not exists idx_backup_backfill_efeito_lote
  on public._backup_backfill_efeito_sem_pagamento(lote, tabela);

comment on table public._backup_backfill_efeito_sem_pagamento is
  'Snapshot linha a linha do backfill de 08/10/2026 (parcelas DEVOLVIDA/SUSPENSA e titulos encerrados). PITR nao esta habilitado: esta tabela E o caminho de reversao.';

-- ---------------------------------------------------------------------------
-- 2. O BACKFILL
-- ---------------------------------------------------------------------------
do $backfill$
declare
  c_lote text := 'backfill_20261008090000';
  -- OS NUMEROS ESPERADOS SAO OS MEDIDOS EM PRODUCAO EM 08/10/2026, e vem de GUC
  -- com esses valores como PADRAO. Em producao ninguem seta o GUC, entao a
  -- trava e exatamente a medicao. O teste de comportamento sobrepoe com o
  -- universo da fixture -- sem isso o backfill seria INTESTAVEL, e um backfill
  -- que nao da para testar e pior que um com trava configuravel.
  c_esp_parc_qtd int := coalesce(nullif(current_setting('backfill.esperado_parcelas_qtd', true),'')::int, 13);
  c_esp_parc_val numeric := coalesce(nullif(current_setting('backfill.esperado_parcelas_valor', true),'')::numeric, 258951.51);
  c_esp_tit_qtd  int := coalesce(nullif(current_setting('backfill.esperado_titulos_qtd', true),'')::int, 17);
  c_esp_tit_val  numeric := coalesce(nullif(current_setting('backfill.esperado_titulos_valor', true),'')::numeric, 130904.96);
  v_parc_qtd int := 0;  v_parc_val numeric := 0;
  v_tit_qtd  int := 0;  v_tit_val  numeric := 0;
  v_ja int;
begin
  -- IDEMPOTENCIA: se o lote ja rodou, nao roda de novo.
  select count(*) into v_ja
    from public._backup_backfill_efeito_sem_pagamento where lote = c_lote;
  if v_ja > 0 then
    raise notice 'backfill: lote % ja aplicado (% linhas em backup). Nada a fazer.', c_lote, v_ja;
    return;
  end if;

  -- ---- 2.1 universo, resolvido UMA vez e congelado -----------------------
  -- O ALVO VEM DO PORTAO CANONICO, nao de `alunos.status_jornada`.
  --
  -- A primeira versao deste backfill lia so `alunos`, e ficava 3 parcelas
  -- (R$ 13.364,19) menor: `aluno_bloqueio_administrativo` tambem le `casos`, e
  -- ha aluno cuja suspensao esta carimbada na ficha e nao no aluno. Universo
  -- medido em 08/10/2026: 118 suspensos + 22 cancelados = 140 alunos, contra
  -- 113 + 21 = 134 pela leitura estreita.
  --
  -- JURIDICO e NAO_ACIONAR_EXPLICITO FICAM DE FORA de proposito: o portao
  -- tambem os devolve, mas a gestao listou SEIS tabulacoes em 07/10/2026 e
  -- juridico nao e uma delas. Alargar aqui seria decidir no lugar dela.
  --
  -- Aluno ao mesmo tempo suspenso e cancelado conta como SUSPENSO -- o portao
  -- devolve suspensao primeiro, e suspensao e o tratamento REVERSIVEL dos dois.
  create temporary table _bf_alvo on commit drop as
  select al.id as aluno_id,
         case when public.aluno_bloqueio_administrativo(al.id)
                   in ('SUSPENSAO_COBRANCA','CANCELAMENTO_COBRANCA')
                then public.aluno_bloqueio_administrativo(al.id)
              when coalesce(nullif(al.status_jornada,''), al.status_atual) = 'ANTECIPACAO_SEMESTRE'
                then 'ANTECIPACAO_SEMESTRE' end as origem
    from public.alunos al;
  delete from _bf_alvo where origem is null;

  create temporary table _bf_parcelas on commit drop as
  select p.id as parcela_id, v.aluno_id,
         case when v.origem = 'SUSPENSAO_COBRANCA' then 'SUSPENSA' else 'DEVOLVIDA' end as efeito,
         v.origem, coalesce(p.valor,0) as valor
    from _bf_alvo v
    join public.acordos a on a.aluno_id = v.aluno_id
    join public.parcelas p on p.acordo_id = a.id
   where upper(coalesce(a.status,'')) not in ('CANCELADO','CANCELADA')
     and public.parcela_viva(p.status)
     -- renegociada conta a mesma divida em outro acordo
     and upper(coalesce(p.status,'')) <> 'RENEGOCIADA';

  create temporary table _bf_titulos on commit drop as
  select t.id as titulo_id, v.aluno_id, v.origem,
         coalesce(t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0) as valor
    from _bf_alvo v
    join public.acordos_titulos t on t.aluno_id = v.aluno_id
         -- SUSPENSAO fica de fora: a divida continua existindo
   where v.origem in ('CANCELAMENTO_COBRANCA','ANTECIPACAO_SEMESTRE')
     and upper(coalesce(t.situacao,'')) in ('ABERTO','NEGOCIADO')
     and coalesce(lower(t.status),'') <> 'quitada'
     and t.origem_encerramento is null
     and not exists (
       select 1 from public.acordo_titulo_vinculo v
         join public.acordos a2 on a2.id = v.acordo_id
        where v.titulo_id = t.id and coalesce(v.ativo, true)
          and upper(coalesce(a2.status,'')) not in ('CANCELADO','CANCELADA'));

  -- ---- 2.1b CARIMBOS DE QUITACAO QUE JA EXISTIAM -------------------------
  -- Snapshot ANTES de escrever. A conferencia do bloco 2.7 compara com isto em
  -- vez de exigir "nenhum caso quitado", que e estado ABSOLUTO e mentiria: ha
  -- aluno em cancelamento cujo acordo foi realmente pago e quitado no passado.
  -- O que o backfill nao pode fazer e ACRESCENTAR carimbo.
  create temporary table _bf_quitado_antes on commit drop as
  select c.id, c.quitado_em, c.origem_quitacao
    from public.casos c
   where c.aluno_id in (select aluno_id from _bf_parcelas
                        union select aluno_id from _bf_titulos);

  -- ---- 2.2 ASSEGURACAO: o universo tem de ser o MEDIDO -------------------
  -- Aqui a contagem exata e o controle certo (ao contrario das migrations
  -- estruturais): isto escreve em dado historico, e dado historico muda. Se o
  -- banco divergiu da medicao de 08/10/2026, a transacao inteira volta e
  -- alguem remede antes de escrever.
  select count(*), round(coalesce(sum(valor),0),2) into v_parc_qtd, v_parc_val from _bf_parcelas;
  select count(*), round(coalesce(sum(valor),0),2) into v_tit_qtd,  v_tit_val  from _bf_titulos;

  if v_parc_qtd <> c_esp_parc_qtd or v_parc_val <> c_esp_parc_val then
    raise exception 'backfill: parcelas elegiveis divergiram da medicao. Esperado % / R$ %, obtive % / R$ %. Remedir antes de aplicar.',
      c_esp_parc_qtd, c_esp_parc_val, v_parc_qtd, v_parc_val;
  end if;
  if v_tit_qtd <> c_esp_tit_qtd or v_tit_val <> c_esp_tit_val then
    raise exception 'backfill: titulos elegiveis divergiram da medicao. Esperado % / R$ %, obtive % / R$ %. Remedir antes de aplicar.',
      c_esp_tit_qtd, c_esp_tit_val, v_tit_qtd, v_tit_val;
  end if;

  -- nenhuma parcela paga pode estar no universo -- cinto e suspensorio
  if exists (select 1 from _bf_parcelas b join public.parcelas p on p.id = b.parcela_id
              where upper(coalesce(p.status,'')) in ('PAGO','PAGA')
                 or p.pago_em is not null or p.origem_baixa is not null) then
    raise exception 'backfill: ha parcela com marca de pagamento no universo. Abortado.';
  end if;

  -- ---- 2.3 BACKUP --------------------------------------------------------
  insert into public._backup_backfill_efeito_sem_pagamento (lote, tabela, registro_id, aluno_id, snapshot)
  select c_lote, 'parcelas', p.id, b.aluno_id, to_jsonb(p.*)
    from _bf_parcelas b join public.parcelas p on p.id = b.parcela_id;

  insert into public._backup_backfill_efeito_sem_pagamento (lote, tabela, registro_id, aluno_id, snapshot)
  select c_lote, 'acordos_titulos', t.id, b.aluno_id, to_jsonb(t.*)
    from _bf_titulos b join public.acordos_titulos t on t.id = b.titulo_id;

  -- ---- 2.4 PARCELAS ------------------------------------------------------
  -- `pago_em`, `origem_baixa*` e `honorarios` NAO aparecem neste UPDATE.
  update public.parcelas p
     set status = b.efeito,
         efeito_sem_pagamento = b.efeito,
         efeito_sem_pagamento_origem = b.origem,
         efeito_sem_pagamento_por = 'backfill 08/10/2026 (gestao)',
         efeito_sem_pagamento_em = now(),
         observacao = coalesce(p.observacao,'')
           || case when coalesce(p.observacao,'') = '' then '' else ' | ' end
           || b.efeito || ' pelo backfill de 08/10/2026: o aluno ja estava em '
           || b.origem || ' antes da regra existir. Sem pagamento, sem baixa e sem honorário.',
         atualizado_em = now()
    from _bf_parcelas b
   where p.id = b.parcela_id;

  -- ---- 2.5 TITULOS (so os definitivos) -----------------------------------
  update public.acordos_titulos t
     set situacao = 'CANCELADA',
         status   = 'cancelada',
         origem_encerramento     = b.origem,
         origem_encerramento_ref = 'backfill:' || c_lote || ':' || b.aluno_id::text,
         origem_encerramento_em  = now(),
         motivo_ajuste = coalesce(t.motivo_ajuste,'')
           || case when coalesce(t.motivo_ajuste,'') = '' then '' else ' | ' end
           || 'encerrado administrativamente pelo backfill de 08/10/2026 (' || b.origem
           || '): o aluno ja estava nessa tabulacao antes da regra existir. '
           || 'Não foi pago a nós. Sem pagamento, acordo ou recuperação.',
         atualizado_em = now()
    from _bf_titulos b
   where t.id = b.titulo_id;

  -- ---- 2.6 AUDITORIA, uma linha por aluno e efeito -----------------------
  insert into public.parcela_efeito_sem_pagamento_auditoria
    (aluno_id, motivo, efeito, origem,
     parcelas_quitadas_qtd, parcelas_quitadas_valor,
     titulos_encerrados_qtd, titulos_encerrados_valor,
     status_anterior, executado_por)
  select u.aluno_id,
         'backfill de 08/10/2026 autorizado pela gestao: aplicacao da regra de '
           || '07/10/2026 ao historico, apos validacao das parcelas elegiveis',
         u.efeito, u.origem,
         coalesce(u.p_qtd,0), coalesce(u.p_val,0),
         coalesce(u.t_qtd,0), coalesce(u.t_val,0),
         u.origem, 'backfill 08/10/2026 (gestao)'
    from (
      select coalesce(p.aluno_id, t.aluno_id) as aluno_id,
             coalesce(p.efeito, 'DEVOLVIDA') as efeito,
             coalesce(p.origem, t.origem) as origem,
             p.qtd as p_qtd, p.val as p_val, t.qtd as t_qtd, t.val as t_val
        from (select aluno_id, efeito, origem, count(*) qtd, round(sum(valor),2) val
                from _bf_parcelas group by 1,2,3) p
        full outer join (select aluno_id, origem, count(*) qtd, round(sum(valor),2) val
                from _bf_titulos group by 1,2) t
          on t.aluno_id = p.aluno_id
    ) u;

  -- ---- 2.7 CONFERENCIA DEPOIS DA ESCRITA ---------------------------------
  if (select count(*) from public.parcelas p join _bf_parcelas b on b.parcela_id = p.id
       where p.status is distinct from b.efeito) > 0 then
    raise exception 'backfill: alguma parcela nao ficou com o status esperado. Abortado.';
  end if;

  if (select count(*) from public.acordos_titulos t join _bf_titulos b on b.titulo_id = t.id
       where upper(coalesce(t.situacao,'')) <> 'CANCELADA') > 0 then
    raise exception 'backfill: algum titulo nao ficou CANCELADA. Abortado.';
  end if;

  -- NENHUM carimbo de quitacao NOVO. Compara com o snapshot de 2.1b: o que ja
  -- era quitado continua quitado (ha acordo realmente pago no historico), mas o
  -- backfill nao pode ter criado nem alterado um.
  if exists (
    select 1 from public.casos c
      join _bf_quitado_antes z on z.id = c.id
     where c.quitado_em is distinct from z.quitado_em
        or coalesce(c.origem_quitacao,'') is distinct from coalesce(z.origem_quitacao,'')) then
    raise exception 'backfill: algum caso teve quitado_em/origem_quitacao ALTERADO. Abortado.';
  end if;

  raise notice 'backfill OK -- parcelas: % (R$ %); titulos: % (R$ %); backup em _backup_backfill_efeito_sem_pagamento lote %.',
    v_parc_qtd, v_parc_val, v_tit_qtd, v_tit_val, c_lote;
end
$backfill$;
