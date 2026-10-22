-- ONDA 1 · EXECUTOR CONTROLADO DO LOTE A (CENÁRIO A, decisão da gestão 21/10/2026)
--
-- Três funções, nenhuma delas executada por esta migration:
--
--   onda1_conferir(uuid)  -- pré-voo. LÊ e não escreve nada.
--   onda1_executar(uuid)  -- aplica, tudo ou nada, só com simulação APROVADA.
--   onda1_reverter(uuid)  -- desfaz sem atropelar o que a operação fez depois.
--
-- O QUE JÁ EXISTIA E FOI REUSADO, em vez de reinventado:
--
--   calibragem_aprovar_simulacao(uuid)  a aprovação explícita da gestão
--   calibragem_simulacoes.status        RASCUNHO -> APROVADA -> EXECUTADA/REVERTIDA
--   calibragem_auditoria                registro individual, append-only por gatilho
--   calibragem_teto_operador(email)     o teto, geral ou individual
--
-- Não criei tabela de log nova: `calibragem_auditoria` já guarda caso, aluno,
-- CPF, nome, operador anterior e novo, valor, motivo, regra e as situações
-- anterior/posterior em jsonb. É nela que a reversão se ancora.
--
-- POR QUE A RECUSA É TOTAL, E NÃO CASO A CASO. O executor do giro de 16/10
-- (giro_2026_10_executar_lote_impl) pula o caso inválido e segue. A gestão pediu
-- o contrário para a Onda 1: impedir a execução inteira se o lote perdeu
-- elegibilidade, se algum aluno ganhou responsável ativo, se nasceu proteção ou
-- se a distribuição passaria do teto. Então `onda1_executar` roda o pré-voo e
-- levanta exceção antes de escrever a primeira linha. Nada pela metade.
--
-- POR QUE `calibragem.bypass_teto` É LIGADO AQUI -- e por que isso ENDURECE, não
-- afrouxa. O gatilho `trigger_impor_teto_operador` reage à troca de dono: se o
-- operador passar do teto, ele LIBERA automaticamente casos de outros alunos
-- daquele operador (operador_email := null) até caber. Isso seria redistribuir
-- caso já atribuído, exatamente o que a gestão NÃO autorizou. A troca é:
--   antes  liberação silenciosa de caso alheio para caber no teto
--   agora  recusa dura no pré-voo, com o nome de quem estouraria, zero escrita
-- O pré-voo usa a MESMA contagem do gatilho (não protegido e não encerrado), e
-- o bypass só garante que o gatilho não faça nada depois que o pré-voo passou.
--
-- RESPONSÁVEL ÚNICO POR ALUNO. A simulação distribui por `cpf_chave`, que é
-- `min(cpf_caso)` agrupado por `aluno_id` -- todos os casos de um aluno caem no
-- mesmo slot. O pré-voo não confia nisso: confere que cada `aluno_id` tem UM só
-- `para_email` nas movimentações e recusa se houver dois. Os 7 alunos com ficha
-- duplicada vão integralmente para o mesmo responsável, os dois casos juntos.
--
-- FICHA DUPLICADA, medido em 21/10 antes de escrever esta migration. O gatilho
-- `trg_zz_caso_nao_duplica_aluno_before` levanta ALUNO_JA_TEM_CASO_ABERTO quando
-- um caso aberto é tocado e o aluno tem OUTRO caso aberto. Nos 7 pares do lote,
-- um dos dois já está fechado para o gatilho (coluna `encerrado_operacional` ou
-- `caso_encerrado_operacional(cpf,...)`), então o aberto não encontra irmão
-- aberto e o fechado sai na primeira linha: 0 de 226 updates levantariam a
-- exceção. E `trg_casos_set_encerrado_operacional` PRESERVA a coluna quando
-- cpf_limpo e os quatro status não mudam -- e este executor não toca nenhum
-- deles. Mesmo assim o pré-voo mede essa condição a cada chamada, porque o
-- estado pode mudar: se um dia os dois casos do par estiverem abertos, ele
-- recusa em vez de deixar o banco derrubar a transação.
--
-- TITULARIDADE FINANCEIRA PRESERVADA. O UPDATE escreve só
-- operador_email, operador_nome, operador e giro_fidelizacao_ate. Não encosta em
-- acordo, título, parcela, vínculo, honorário, valor_pago, quitado_em,
-- status_financeiro nem em operador_acordo/operador_mensalidade. Quem é titular
-- do acordo continua titular; muda apenas quem acompanha.
--
-- FIDELIZAÇÃO DE 10 DIAS. `giro_fidelizacao_ate` recebe o `fidelizacao_ate`
-- gravado na própria simulação (2026-10-31 nesta, = hoje em Brasília + 10). O
-- gatilho `trg_giro_limpar_marca` zera a marca quando o dono muda E a marca NÃO
-- muda na mesma linha; como escrevemos as duas no MESMO update, a marca sobrevive.
-- Trocar isso por dois updates separados apagaria a fidelização.
--
-- SEM LOTE. São 226 casos: cabe numa transação. Lote existe no giro porque lá
-- eram milhares. Aqui, tudo ou nada.
--
-- Reversível: supabase/rollbacks/20261021200000_*.rollback.sql

-- ---------------------------------------------------------------------------
-- PRÉ-VOO. Não escreve nada: só mede e devolve o veredito.
-- ---------------------------------------------------------------------------
create or replace function public.onda1_conferir(p_simulacao_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path to 'public'
as $fn$
declare
  v_sim record; v_imp jsonb := '[]'::jsonb; v_fid date;
  v_n int; v_amostra text;
begin
  if not (public.calibragem_e_gestao() or auth.jwt() is null) then
    raise exception 'Sem permissão para conferir a Onda 1.' using errcode = '42501';
  end if;

  select * into v_sim from public.calibragem_simulacoes where id = p_simulacao_id;
  if not found then raise exception 'Simulação % não encontrada.', p_simulacao_id; end if;
  if coalesce(v_sim.resultado->>'metrica','') <> 'ONDA1_LOTE_A' then
    raise exception 'Esta simulação não é a Onda 1 do lote A (metrica: %).',
      coalesce(nullif(v_sim.resultado->>'metrica',''),'(sem)');
  end if;

  v_fid := nullif(v_sim.resultado->>'fidelizacao_ate','')::date;

  -- O plano, como a simulação o gravou. O `drop` antes de cada `create` deixa
  -- conferir e executar conviverem na MESMA transação: temp table `on commit
  -- drop` só morre no commit, e um segundo `create` sem isto quebraria.
  drop table if exists _m;
  create temp table _m on commit drop as
  select (m->>'caso_id')::uuid caso_id, nullif(m->>'de_email','') de_email,
         nullif(m->>'para_email','') para_email, m->>'cpf' cpf, m->>'nome' nome,
         (m->>'valor')::numeric valor, m->>'motivo' motivo
    from jsonb_array_elements(v_sim.resultado->'movimentacoes') m;

  -- O estado de hoje dos casos do plano.
  drop table if exists _hoje;
  create temp table _hoje on commit drop as
  select m.caso_id, m.de_email, m.para_email, c.id is not null as existe,
         c.aluno_id, c.operador_email as dono_hoje,
         coalesce(c.nao_acionar,false) as nao_acionar,
         public.caso_encerrado_operacional(c.cpf_limpo, c.status_atual, c.status_acionamento,
           c.status_financeiro, c.status_jornada) as encerrado,
         public.caso_em_giro_fidelizacao(c.giro_fidelizacao_ate) as marca_viva,
         (coalesce(c.encerrado_operacional,false)
          or public.caso_encerrado_operacional(c.cpf, c.status_atual, c.status_acionamento,
               c.status_financeiro, c.status_jornada)) as fechado_para_o_gatilho
    from _m m left join public.casos c on c.id = m.caso_id;

  -- 1. Caso que não existe mais.
  select count(*) into v_n from _hoje where not existe;
  if v_n > 0 then v_imp := v_imp || jsonb_build_object(
    'condicao','CASO_INEXISTENTE','quantidade',v_n,
    'explicacao','Caso do plano não existe mais na base.'); end if;

  -- 2. O caso saiu do dono de origem: alguém mexeu depois da simulação.
  select count(*), string_agg(distinct coalesce(dono_hoje,'(sem dono)'), ', ')
    into v_n, v_amostra
    from _hoje where existe and dono_hoje is distinct from de_email;
  if v_n > 0 then v_imp := v_imp || jsonb_build_object(
    'condicao','DONO_DE_ORIGEM_MUDOU','quantidade',v_n,'donos_atuais',v_amostra,
    'explicacao','O caso já não está com quem a simulação viu. Simule de novo.'); end if;

  -- 3. Aluno ganhou responsável ATIVO -- não se tira caso de quem já o trabalha.
  select count(distinct h.aluno_id) into v_n
    from _hoje h
   where h.existe and exists (
     select 1 from public.casos c join public.usuarios u on lower(u.email) = lower(c.operador_email)
      where c.aluno_id = h.aluno_id and u.ativo and u.perfil = 'operador');
  if v_n > 0 then v_imp := v_imp || jsonb_build_object(
    'condicao','ALUNO_COM_RESPONSAVEL_ATIVO','quantidade',v_n,
    'explicacao','Aluno passou a ter operador ativo. Sai da Onda 1 por desenho.'); end if;

  -- 4. Proteção nascida depois da simulação, cada motivo separado.
  select count(*) into v_n from _hoje where existe and nao_acionar;
  if v_n > 0 then v_imp := v_imp || jsonb_build_object(
    'condicao','NOVA_PROTECAO_NAO_ACIONAR','quantidade',v_n,
    'explicacao','Bloqueio de cobrança marcado no caso.'); end if;

  select count(*) into v_n from _hoje where existe and encerrado;
  if v_n > 0 then v_imp := v_imp || jsonb_build_object(
    'condicao','NOVA_PROTECAO_ENCERRADO','quantidade',v_n,
    'explicacao','Caso encerrado, suspenso, cancelado ou jurídico.'); end if;

  select count(*) into v_n from _hoje where existe and marca_viva;
  if v_n > 0 then v_imp := v_imp || jsonb_build_object(
    'condicao','NOVA_PROTECAO_MARCA_DE_GIRO','quantidade',v_n,
    'explicacao','Fidelização de lote em curso: não se mexe.'); end if;

  select count(distinct h.aluno_id) into v_n
    from _hoje h
   where h.existe and exists (
     select 1 from public.solicitacoes_confirmacao_pagamento s
      where s.aluno_id = h.aluno_id::text
        and s.status in ('AGUARDANDO_CONFIRMACAO','PAGAMENTO_RECEBIDO_AGUARDANDO_VINCULO'));
  if v_n > 0 then v_imp := v_imp || jsonb_build_object(
    'condicao','NOVA_PROTECAO_CONFIRMACAO_ABERTA','quantidade',v_n,
    'explicacao','Dinheiro em trânsito: confirmação de pagamento aberta.'); end if;

  -- 5. Perdeu elegibilidade: nem mensalidade 2026 aberta, nem acordo vivo de 2026.
  --    Mesmas definições da simulação, restritas aos alunos do plano.
  select count(*) into v_n from (
    select distinct h.aluno_id from _hoje h where h.existe and h.aluno_id is not null
    except
    select t.aluno_id
      from public.acordos_titulos t
      left join public.prime_titulo_semestre ps on ps.boleto = t.documento
     where upper(coalesce(t.situacao,'')) = 'ABERTO' and lower(coalesce(t.status,'')) = 'em_aberto'
       and t.acordo_id is null and coalesce(t.tipo_boleto,'') <> 'Acordo'
       and t.aluno_id is not null
       and round(coalesce(t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0),2) > 0
       and not exists (select 1 from public.acordo_titulo_vinculo v
                        where v.titulo_id = t.id and coalesce(v.ativo, true))
       and not public.titulo_superado_por_acordo(t.aluno_id, t.vencimento)
       and coalesce(ps.semestre,
             case when t.vencimento >= date '2026-01-01' and t.vencimento < date '2026-07-01' then '2026/1'
                  when t.vencimento >= date '2026-07-01' and t.vencimento < date '2027-01-01' then '2026/2' end)
           in ('2026/1','2026/2')
    except
    select a.aluno_id
      from public.acordos a
      join public.acordo_titulo_vinculo v on v.acordo_id = a.id and coalesce(v.ativo,true)
      join public.acordos_titulos t on t.id = v.titulo_id
      left join public.prime_titulo_semestre ps on ps.boleto = t.documento
     where lower(coalesce(a.status,'')) not in ('cancelado','cancelada') and a.aluno_id is not null
       and exists (select 1 from public.parcelas p
                    where p.acordo_id = a.id and public.parcela_viva(p.status))
       and coalesce(ps.semestre,
             case when t.vencimento >= date '2026-01-01' and t.vencimento < date '2026-07-01' then '2026/1'
                  when t.vencimento >= date '2026-07-01' and t.vencimento < date '2027-01-01' then '2026/2' end)
           in ('2026/1','2026/2')
  ) x;
  if v_n > 0 then v_imp := v_imp || jsonb_build_object(
    'condicao','PERDEU_ELEGIBILIDADE','quantidade',v_n,
    'explicacao','Aluno não tem mais mensalidade 2026 aberta nem acordo vivo de 2026.'); end if;

  -- 6. Responsável único por aluno: dois destinos para o mesmo aluno é defeito de plano.
  select count(*) into v_n from (
    select aluno_id from _hoje where existe and aluno_id is not null
     group by aluno_id having count(distinct para_email) > 1) y;
  if v_n > 0 then v_imp := v_imp || jsonb_build_object(
    'condicao','ALUNO_COM_DOIS_DESTINOS','quantidade',v_n,
    'explicacao','O plano mandaria os casos do mesmo aluno para operadores diferentes.'); end if;

  -- 7. Destino inválido: operador que saiu, foi desativado ou perdeu o perfil.
  select count(distinct h.para_email) into v_n
    from _hoje h
   where h.existe and (h.para_email is null or not exists (
     select 1 from public.usuarios u
      where lower(u.email) = lower(h.para_email) and u.ativo and u.perfil = 'operador'));
  if v_n > 0 then v_imp := v_imp || jsonb_build_object(
    'condicao','DESTINO_NAO_E_OPERADOR_ATIVO','quantidade',v_n,
    'explicacao','Operador de destino não está ativo com perfil de operador.'); end if;

  -- 8. TETO. Mesma contagem do gatilho trigger_impor_teto_operador.
  drop table if exists _teto;
  create temp table _teto on commit drop as
  select h.para_email as email,
         (select count(*) from public.casos c
           where c.operador_email = h.para_email
             and not public.caso_protegido_redistribuicao(c.cpf_limpo, c.status_acionamento,
                   c.nao_acionar, c.status_financeiro, c.valor_pago, c.quitado_em, c.valor_quitado)
             and not public.caso_encerrado_operacional(c.cpf_limpo, c.status_atual,
                   c.status_acionamento, c.status_financeiro, c.status_jornada)) as ativos_antes,
         count(*) as entram,
         public.calibragem_teto_operador(h.para_email) as teto
    from _hoje h where h.existe and h.para_email is not null
   group by h.para_email;

  select count(*), string_agg(email||' ('||(ativos_antes+entram)||' > '||teto||')', ', ' order by email)
    into v_n, v_amostra from _teto where ativos_antes + entram > teto;
  if v_n > 0 then v_imp := v_imp || jsonb_build_object(
    'condicao','TETO_ESTOURADO','quantidade',v_n,'quem',v_amostra,
    'explicacao','A distribuição passaria do teto. Nada é escrito.'); end if;

  -- 9. Ficha duplicada: o update levantaria ALUNO_JA_TEM_CASO_ABERTO no banco.
  select count(*) into v_n
    from _hoje h
   where h.existe and not h.fechado_para_o_gatilho
     and exists (select 1 from public.casos o
                  where o.aluno_id = h.aluno_id and o.id <> h.caso_id
                    and not coalesce(o.encerrado_operacional,false)
                    and public.caso_encerrado_operacional(o.cpf, o.status_atual,
                          o.status_acionamento, o.status_financeiro, o.status_jornada) = false);
  if v_n > 0 then v_imp := v_imp || jsonb_build_object(
    'condicao','FICHA_DUPLICADA_ABERTA','quantidade',v_n,
    'explicacao','Aluno com dois casos abertos: o banco recusaria o update. Consolide a ficha primeiro.'); end if;

  -- 10. Fidelização sem data é fidelização que não existe.
  if v_fid is null then v_imp := v_imp || jsonb_build_object(
    'condicao','SEM_FIDELIZACAO_ATE','quantidade',1,
    'explicacao','A simulação não gravou fidelizacao_ate; a marca de 10 dias não teria data.'); end if;

  return jsonb_build_object(
    'simulacao_id', p_simulacao_id,
    'metrica', v_sim.resultado->>'metrica',
    'status', v_sim.status,
    'fidelizacao_ate', v_fid,
    'casos_no_plano', (select count(*) from _m),
    'alunos_no_plano', (select count(distinct aluno_id) from _hoje where aluno_id is not null),
    'por_operador', (select coalesce(jsonb_agg(jsonb_build_object(
         'email', email, 'ativos_antes', ativos_antes, 'entram', entram,
         'depois', ativos_antes + entram, 'teto', teto,
         'folga', teto - (ativos_antes + entram)) order by email),'[]') from _teto),
    'impedimentos', v_imp,
    'pode_executar', jsonb_array_length(v_imp) = 0);
end;
$fn$;

comment on function public.onda1_conferir(uuid) is
  'Pré-voo da Onda 1: mede as dez condições que impedem a execução e devolve '
  'pode_executar. NÃO ESCREVE NADA -- só temp tables, que morrem no commit.';

-- ---------------------------------------------------------------------------
-- EXECUÇÃO. Tudo ou nada, só com simulação APROVADA pela gestão.
-- ---------------------------------------------------------------------------
create or replace function public.onda1_executar(p_simulacao_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path to 'public'
as $fn$
declare
  v_sim record; v_pre jsonb; v_email text := coalesce(auth.jwt() ->> 'email','server');
  v_fid date; v_movidos int := 0;
begin
  if not (public.calibragem_e_gestao() or auth.jwt() is null) then
    raise exception 'Sem permissão para executar a Onda 1.' using errcode = '42501';
  end if;

  -- Trava compartilhada com nivelamento e giro: nunca correm juntos.
  perform pg_advisory_xact_lock(hashtext('calibragem_executar_nivelamento'));

  select * into v_sim from public.calibragem_simulacoes where id = p_simulacao_id for update;
  if not found then raise exception 'Simulação % não encontrada.', p_simulacao_id; end if;

  -- APROVAÇÃO EXPLÍCITA. RASCUNHO não executa: a gestão precisa aprovar antes,
  -- por calibragem_aprovar_simulacao(), que grava quem aprovou e quando.
  if v_sim.status <> 'APROVADA' then
    raise exception 'A Onda 1 só executa com a simulação APROVADA (atual: %). Aprove com calibragem_aprovar_simulacao(%L).',
      v_sim.status, p_simulacao_id using errcode = '42501';
  end if;

  -- PRÉ-VOO. Qualquer impedimento aborta antes da primeira escrita.
  v_pre := public.onda1_conferir(p_simulacao_id);
  if not (v_pre->>'pode_executar')::boolean then
    raise exception 'Onda 1 recusada pelo pré-voo. Nada foi escrito. Impedimentos: %',
      v_pre->'impedimentos';
  end if;

  v_fid := (v_pre->>'fidelizacao_ate')::date;

  drop table if exists _ap;
  create temp table _ap on commit drop as
  select (m->>'caso_id')::uuid caso_id, nullif(m->>'de_email','') de_email,
         m->>'de_nome' de_nome, nullif(m->>'para_email','') para_email,
         m->>'para_nome' para_nome, m->>'cpf' cpf, m->>'nome' nome,
         (m->>'valor')::numeric valor, m->>'motivo' motivo
    from jsonb_array_elements(v_sim.resultado->'movimentacoes') m;

  -- Guarda o estado de antes para a reversão poder devolver a marca também.
  drop table if exists _antes;
  create temp table _antes on commit drop as
  select c.id caso_id, c.aluno_id, c.operador_email, c.operador_nome, c.giro_fidelizacao_ate
    from public.casos c join _ap a on a.caso_id = c.id;

  -- O gatilho do teto não pode liberar caso alheio: o pré-voo já garantiu o teto.
  perform set_config('calibragem.bypass_teto','on', true);

  -- Dono e marca de 10 dias no MESMO update: separados, trg_giro_limpar_marca
  -- apagaria a fidelização que acabamos de dar.
  update public.casos c
     set operador_email       = a.para_email,
         operador_nome        = a.para_nome,
         operador             = upper(coalesce(a.para_nome,'')),
         giro_fidelizacao_ate = v_fid
    from _ap a
   where c.id = a.caso_id;
  get diagnostics v_movidos = row_count;

  -- Registro individual de cada movimentação.
  insert into public.calibragem_auditoria(evento, simulacao_id, caso_id, aluno_id, cpf, nome_aluno,
    operador_anterior_email, operador_anterior_nome, operador_novo_email, operador_novo_nome,
    valor_caso, motivo, regra, situacao_anterior, situacao_posterior,
    aprovado_por_email, aprovado_por_nome, registrado_por_email)
  select 'MOVIMENTACAO_ONDA1', p_simulacao_id, a.caso_id, b.aluno_id, a.cpf, a.nome,
         b.operador_email, b.operador_nome, c.operador_email, c.operador_nome,
         a.valor, a.motivo, 'ONDA1_LOTE_A',
         jsonb_build_object('operador_email', b.operador_email, 'operador_nome', b.operador_nome,
                            'giro_fidelizacao_ate', b.giro_fidelizacao_ate),
         jsonb_build_object('operador_email', c.operador_email, 'operador_nome', c.operador_nome,
                            'giro_fidelizacao_ate', c.giro_fidelizacao_ate),
         v_sim.aprovado_por_email, v_sim.aprovado_por_nome, v_email
    from _ap a
    join _antes b on b.caso_id = a.caso_id
    join public.casos c on c.id = a.caso_id;

  update public.calibragem_simulacoes
     set status = 'EXECUTADA', executado_em = now()
   where id = p_simulacao_id;

  return jsonb_build_object('simulacao_id', p_simulacao_id, 'status','EXECUTADA',
    'casos_movidos', v_movidos,
    'alunos', (select count(distinct aluno_id) from _antes),
    'fidelizacao_ate', v_fid,
    'por_operador', v_pre->'por_operador');
end;
$fn$;

comment on function public.onda1_executar(uuid) is
  'Aplica a Onda 1 do lote A, tudo ou nada, só com a simulação APROVADA e o '
  'pré-voo limpo. Escreve operador e marca de 10 dias nos casos e uma linha de '
  'auditoria por movimentação. Não toca acordo, título, parcela nem honorário.';

-- ---------------------------------------------------------------------------
-- REVERSÃO. Só devolve o que AINDA está como a Onda 1 deixou.
-- ---------------------------------------------------------------------------
create or replace function public.onda1_reverter(p_simulacao_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path to 'public'
as $fn$
declare
  v_sim record; v_email text := coalesce(auth.jwt() ->> 'email','server');
  v_voltaram int := 0; v_pulados int := 0;
begin
  if not (public.calibragem_e_gestao() or auth.jwt() is null) then
    raise exception 'Sem permissão para reverter a Onda 1.' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtext('calibragem_executar_nivelamento'));

  select * into v_sim from public.calibragem_simulacoes where id = p_simulacao_id for update;
  if not found then raise exception 'Simulação % não encontrada.', p_simulacao_id; end if;
  if coalesce(v_sim.resultado->>'metrica','') <> 'ONDA1_LOTE_A' then
    raise exception 'Esta simulação não é a Onda 1 do lote A.';
  end if;
  if v_sim.status <> 'EXECUTADA' then
    raise exception 'Só dá para reverter uma Onda 1 EXECUTADA (atual: %).', v_sim.status;
  end if;

  -- O que a Onda 1 moveu, e que ainda não foi revertido.
  drop table if exists _volta;
  create temp table _volta on commit drop as
  select a.caso_id, a.aluno_id, a.cpf, a.nome_aluno, a.valor_caso,
         a.operador_anterior_email, a.operador_anterior_nome, a.operador_novo_email,
         nullif(a.situacao_anterior->>'giro_fidelizacao_ate','')::date as giro_antes,
         false as valido
    from public.calibragem_auditoria a
   where a.simulacao_id = p_simulacao_id and a.evento = 'MOVIMENTACAO_ONDA1'
     and not exists (select 1 from public.calibragem_auditoria r
                      where r.simulacao_id = p_simulacao_id and r.caso_id = a.caso_id
                        and r.evento in ('REVERSAO_ONDA1','PULADO_REVERSAO_ONDA1'));

  -- SÓ VOLTA O QUE NÃO FOI MEXIDO DEPOIS. Se a operação já remanejou o caso, ou
  -- se o novo dono acionou e o caso ficou protegido (negociação, acordo, link,
  -- termo, pagamento), não se desfaz nada -- sobrescrever apagaria trabalho real.
  update _volta v set valido = true
    from public.casos c
   where c.id = v.caso_id
     and c.operador_email is not distinct from v.operador_novo_email
     and not public.caso_protegido_redistribuicao(c.cpf_limpo, c.status_acionamento,
           c.nao_acionar, c.status_financeiro, c.valor_pago, c.quitado_em, c.valor_quitado);

  perform set_config('calibragem.bypass_teto','on', true);

  -- Devolve dono e marca juntos, pelo mesmo motivo da ida.
  update public.casos c
     set operador_email       = v.operador_anterior_email,
         operador_nome        = v.operador_anterior_nome,
         operador             = case when v.operador_anterior_email is null then null
                                     else upper(coalesce(v.operador_anterior_nome,'')) end,
         giro_fidelizacao_ate = v.giro_antes
    from _volta v
   where v.valido and c.id = v.caso_id;
  get diagnostics v_voltaram = row_count;

  insert into public.calibragem_auditoria(evento, simulacao_id, caso_id, aluno_id, cpf, nome_aluno,
    operador_anterior_email, operador_anterior_nome, operador_novo_email, operador_novo_nome,
    valor_caso, motivo, regra, situacao_anterior, situacao_posterior,
    aprovado_por_email, aprovado_por_nome, registrado_por_email)
  select 'REVERSAO_ONDA1', p_simulacao_id, v.caso_id, v.aluno_id, v.cpf, v.nome_aluno,
         v.operador_novo_email, null, v.operador_anterior_email, v.operador_anterior_nome,
         v.valor_caso, 'Onda 1 desfeita pela gestão: caso devolvido ao estado anterior.',
         'ONDA1_LOTE_A',
         jsonb_build_object('operador_email', v.operador_novo_email),
         jsonb_build_object('operador_email', v.operador_anterior_email,
                            'giro_fidelizacao_ate', v.giro_antes),
         v_sim.aprovado_por_email, v_sim.aprovado_por_nome, v_email
    from _volta v where v.valido;

  insert into public.calibragem_auditoria(evento, simulacao_id, caso_id, aluno_id, cpf, nome_aluno,
    operador_anterior_email, operador_anterior_nome, operador_novo_email, operador_novo_nome,
    valor_caso, motivo, regra, situacao_anterior, situacao_posterior,
    aprovado_por_email, aprovado_por_nome, registrado_por_email)
  select 'PULADO_REVERSAO_ONDA1', p_simulacao_id, v.caso_id, v.aluno_id, v.cpf, v.nome_aluno,
         v.operador_novo_email, null, v.operador_anterior_email, v.operador_anterior_nome,
         v.valor_caso,
         'Não devolvido: o caso já saiu das mãos de quem o recebeu ou está protegido (negociação, acordo, link, termo, pagamento).',
         'ONDA1_LOTE_A', '{}'::jsonb, '{}'::jsonb,
         v_sim.aprovado_por_email, v_sim.aprovado_por_nome, v_email
    from _volta v where not v.valido;
  get diagnostics v_pulados = row_count;

  if not exists (select 1 from public.calibragem_auditoria a
                  where a.simulacao_id = p_simulacao_id and a.evento = 'MOVIMENTACAO_ONDA1'
                    and not exists (select 1 from public.calibragem_auditoria r
                                     where r.simulacao_id = p_simulacao_id and r.caso_id = a.caso_id
                                       and r.evento in ('REVERSAO_ONDA1','PULADO_REVERSAO_ONDA1')))
  then
    update public.calibragem_simulacoes
       set status = 'REVERTIDA',
           observacao = trim(coalesce(observacao,'') || ' | Onda 1 desfeita por ' || v_email
                             || ' em ' || to_char(now() at time zone 'America/Sao_Paulo','DD/MM/YYYY HH24:MI'))
     where id = p_simulacao_id;
  end if;

  return jsonb_build_object('simulacao_id', p_simulacao_id, 'voltaram', v_voltaram,
    'pulados', v_pulados, 'status',
    (select status from public.calibragem_simulacoes where id = p_simulacao_id));
end;
$fn$;

comment on function public.onda1_reverter(uuid) is
  'Desfaz a Onda 1 devolvendo dono e marca de fidelização ao estado anterior, '
  'SÓ nos casos que ainda estão como ela os deixou. O que a operação mexeu '
  'depois fica intacto e sai registrado como PULADO_REVERSAO_ONDA1.';

-- ---------------------------------------------------------------------------
-- PERMISSÕES. Função nova nasce com EXECUTE para PUBLIC -- herança do Postgres,
-- que foi o defeito corrigido hoje pela 20261021180155. Aqui já nasce fechada.
-- Restringir é revoke de PUBLIC/anon, NUNCA de authenticated.
-- ---------------------------------------------------------------------------
revoke all on function public.onda1_conferir(uuid) from public;
revoke all on function public.onda1_conferir(uuid) from anon;
revoke all on function public.onda1_executar(uuid) from public;
revoke all on function public.onda1_executar(uuid) from anon;
revoke all on function public.onda1_reverter(uuid) from public;
revoke all on function public.onda1_reverter(uuid) from anon;

grant execute on function public.onda1_conferir(uuid) to authenticated, service_role;
grant execute on function public.onda1_executar(uuid) to authenticated, service_role;
grant execute on function public.onda1_reverter(uuid) to authenticated, service_role;
