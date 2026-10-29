-- GIRO TOTAL DAS CARTEIRAS 2026/1 E 2026/2 (pedido da gestao em 16/10/2026)
--
-- NAO APLICADA. Este arquivo esta escrito e revisado; a aplicacao depende de
-- autorizacao expressa. Desenho, numeros medidos e decisoes:
--   docs/GIRO-CARTEIRAS-2026-1-2026-2-DESENHO.md
--   docs/GIRO-CARTEIRAS-2026-1-2026-2-SIMULACAO.md
--
-- O QUE MUDA EM RELACAO AO GIRO DE 10/09 (GIRO_2026), e por que nao reaproveita
-- aquelas funcoes:
--
--   1. O giro de 10/09 foi DESATIVADO em 29/09 por decisao da gestao
--      ("nao havera novo giro"). Aquela decisao e aquele historico ficam
--      INTACTOS: este arquivo nao remove a marca GIRO_DESATIVADO, nao altera
--      calibragem_simular_giro_2026 nem calibragem_executar_giro_lote_impl.
--      O giro novo vive em funcoes proprias, com metrica propria GIRO_2026_10.
--   2. O semestre passa a ser POR TITULO e HIBRIDO: prime_titulo_semestre
--      (janela do contrato da serie, fonte oficial da integracao; cobertura
--      medida 97,2%) com o mes de vencimento como fallback. O giro de 10/09
--      classificava o CPF inteiro pelo vencimento mais recente (venc_max), o
--      que joga para 2026/2 quem deve nos dois semestres.
--   3. A distribuicao e em DUAS PASSADAS com prioridade 2026/2 (decisao da
--      gestao em 16/10): primeiro os CPFs com divida em 2026/2, pelo saldo
--      dessa safra; depois os de 2026/1 por cota, com alternancia. Cada CPF
--      continua com UM operador, considerando os dois semestres juntos.
--   4. A execucao grava a titularidade da MENSALIDADE
--      (casos.operador_mensalidade_email) alem do responsavel do caso.
--   5. A execucao grava a fidelizacao excepcional (casos.giro_fidelizacao_ate),
--      que ate 26/10 tira o aluno de TODA acao massiva (secao 2c) e, depois
--      dela, abre o caso para qualquer operador ativo assumir pelo fluxo
--      normal, preservando o responsavel atual ate que alguem assuma (2d).
--
-- O QUE ESTE ARQUIVO NAO FAZ:
--   * nao move caso nenhum -- a simulacao so grava RASCUNHO; mover exige
--     aprovar a simulacao e chamar o executor em lotes;
--   * nao toca em acordo, pagamento, baixa, termo, valor ou titulo;
--   * nao altera a regra geral de fidelizacao de 10 dias das demais carteiras:
--     a guarda nova so olha uma coluna que nasce NULA e que so o giro preenche;
--   * nao agenda cron nenhum.
--
-- A UNICA MUDANCA DE REGRA GERAL AQUI: o teto da carteira sobe de 500 para 700
-- (secao 5), por decisao da gestao em 16/10. Sem isso o gatilho de teto
-- devolveria ao pool o excedente logo depois do giro -- medido: os 7 operadores
-- terminam entre 568 e 634 casos ativos. Valor anterior: 500, posto por
-- migration em 30/07/2026. Reverter: select public.calibragem_definir_teto(500, null);
--
-- REVERSAO: a execucao grava evento MOVIMENTACAO_NIVELAMENTO em
-- calibragem_auditoria, de proposito, para que
-- calibragem_desfazer_nivelamento_lote(simulacao_id, tamanho) -- que ja existe
-- e nao e alterada aqui -- desfaca o giro devolvendo cada caso ao dono
-- anterior registrado. Nao ha PITR no projeto: a reversao e essa, por id
-- exato, nunca restore.


-- ===========================================================================
-- 1. FIDELIZACAO EXCEPCIONAL DO GIRO
-- ===========================================================================
-- Coluna propria, e nao reuso de data_ultimo_acionamento: aquele campo e prova
-- operacional (alimenta "Meu dia", sem-acionamento, efetividade) e sobrescreve-lo
-- marcaria milhares de casos como acionados hoje, o que seria falso.
-- casos.fidelizacao_inicio (a v2 de 30/09) NAO existe em producao -- conferido
-- em 16/10 --, entao nao ha carona a pegar.

alter table public.casos
  add column if not exists giro_fidelizacao_ate date;

create index if not exists idx_casos_giro_fidelizacao_ate
  on public.casos (giro_fidelizacao_ate) where giro_fidelizacao_ate is not null;

comment on column public.casos.giro_fidelizacao_ate is
  'Fidelizacao excepcional de giro: ate esta data (inclusive, em data local de '
  'Brasilia) nenhuma rotina automatica retira o caso do operador. Nasce NULA e '
  'so e preenchida pela execucao de um giro. NULA significa "regra normal dos '
  '10 dias", que continua valendo para todo o resto da carteira.';

-- Data LOCAL de Brasilia, nunca current_date: o banco roda em UTC e current_date
-- vira o dia seguinte as 21:00 BRT -- a fidelizacao terminaria um dia antes para
-- quem olhasse a partir do fim da tarde.
create or replace function public.caso_em_giro_fidelizacao(p_ate date)
returns boolean
language sql
stable
set search_path to 'public'
as $$
  select p_ate is not null
     and p_ate >= (now() at time zone 'America/Sao_Paulo')::date;
$$;

comment on function public.caso_em_giro_fidelizacao(date) is
  'Caso dentro da fidelizacao excepcional de um giro. Espelha '
  'caso_dentro_prazo_fidelizacao, mas por data fixa e em fuso de Brasilia.';

revoke all on function public.caso_em_giro_fidelizacao(date) from public, anon;
grant execute on function public.caso_em_giro_fidelizacao(date) to authenticated, service_role;


-- ===========================================================================
-- 2. AS DUAS PORTAS AUTOMATICAS QUE PRECISAM CONHECER A FIDELIZACAO NOVA
-- ===========================================================================
-- Patch ANCORADO, nao reescrita: le pg_get_functiondef e troca so o trecho.
-- Reescrever a funcao inteira a partir do repositorio arriscaria desfazer
-- patches que so existem em producao.

-- 2a. liberar_fidelizacao_caso -- a ponta UNICA que solta o caso.
--     O cron fidelizacao_liberar_vencidos (20 8 * * *, ATIVO, sem limite de
--     lote) passa por aqui. Medido em 16/10: dos 3.943 casos que o giro
--     entrega, 525 ja estao fora da janela de 10 dias e seriam soltos na
--     primeira manha sem esta guarda.
do $mig$
declare
  v_def text := pg_get_functiondef('public.liberar_fidelizacao_caso(uuid,text,text)'::regprocedure);
  v_ancora text := 'if public.caso_dentro_prazo_fidelizacao(v_c.data_ultimo_acionamento) then';
  v_novo text;
begin
  if position('caso_em_giro_fidelizacao' in v_def) > 0 then
    raise notice 'liberar_fidelizacao_caso ja conhece o giro; nada a fazer.';
    return;
  end if;
  if position(v_ancora in v_def) = 0 then
    raise exception 'ancora nao encontrada em liberar_fidelizacao_caso';
  end if;
  -- Olha a MARCA, nao a data: ate 26/10 porque o caso esta fidelizado, e depois
  -- de 26/10 porque o responsavel e preservado ate OUTRO OPERADOR ASSUMIR
  -- (decisao da gestao em 16/10). Quem assume limpa a marca e o caso volta
  -- inteiro a regra normal dos 10 dias.
  v_novo := 'if v_c.giro_fidelizacao_ate is not null then
    -- Caso de giro: nao volta ao pool por rotina automatica. Ate a data da
    -- fidelizacao por exclusividade; depois dela, para preservar o responsavel
    -- ate que outro operador assuma pelo fluxo normal.
    return false;
  end if;

  ' || v_ancora;
  execute replace(v_def, v_ancora, v_novo);
end $mig$;

-- 2b. trigger_impor_teto_operador -- dispara em toda troca de dono (AFTER
--     UPDATE ... WHEN new.operador_email is distinct from old) e libera o
--     EXCEDENTE acima do teto, escolhendo os de menor valor em aberto que
--     estejam fora da janela de 10 dias. Sem esta guarda, a primeira
--     atribuicao manual depois do giro devolveria ao pool casos recem-girados.
do $mig$
declare
  v_def text := pg_get_functiondef('public.trg_impor_teto_operador()'::regprocedure);
  v_ancora text := 'AND NOT public.caso_dentro_prazo_fidelizacao(c.data_ultimo_acionamento)';
  v_novo text;
begin
  if position('caso_em_giro_fidelizacao' in v_def) > 0 then
    raise notice 'trg_impor_teto_operador ja conhece o giro; nada a fazer.';
    return;
  end if;
  if position(v_ancora in v_def) = 0 then
    raise exception 'ancora nao encontrada em trg_impor_teto_operador';
  end if;
  -- Tambem pela MARCA, pelo mesmo motivo da 2a: o teto nunca escolhe um caso
  -- de giro para devolver ao pool, nem depois de 26/10.
  v_novo := v_ancora || '
     AND c.giro_fidelizacao_ate IS NULL';
  execute replace(v_def, v_ancora, v_novo);
end $mig$;

-- 2c. acoes_massivas_universo(jsonb) -- a FONTE UNICA de quem entra em acao
--     massiva. Conferido em 16/10: previa, exportar, drilldown, cobertura,
--     matriz de camadas e registrar_acao_massiva passam todas por ela, entao
--     um motivo de indisponibilidade aqui bloqueia previa, selecao, exportacao
--     e registro de uma vez -- inclusive as externas, que sao registradas pelo
--     mesmo caminho.
--
--     NAO renova a fidelizacao do giro: `giro_fidelizacao_ate` e data fixa e
--     so o executor do giro a escreve. Acao massiva mexe em
--     `data_ultimo_acionamento`, que e outro campo -- e, com este bloqueio, o
--     aluno do giro nem entra na acao.
do $mig$
declare
  v_def text := pg_get_functiondef('public.acoes_massivas_universo(jsonb)'::regprocedure);
  v_anc_flag text := 'or (v_sem_tel and z.f_tel) as f_ctt';
  v_anc_mot  text := 'when e.f_enc then ''encerrado_operacional''';
begin
  if position('giro_fidelizacao' in v_def) > 0 then
    raise notice 'acoes_massivas_universo ja conhece o giro; nada a fazer.';
    return;
  end if;
  if position(v_anc_flag in v_def) = 0 or position(v_anc_mot in v_def) = 0 then
    raise exception 'ancora nao encontrada em acoes_massivas_universo';
  end if;

  -- A flag: o aluno tem caso dentro da fidelizacao excepcional do giro.
  v_def := replace(v_def, v_anc_flag, v_anc_flag || ',
           exists (select 1 from public.casos gc
                    where gc.aluno_id = z.id
                      and public.caso_em_giro_fidelizacao(gc.giro_fidelizacao_ate)) as f_giro');

  -- O motivo, nos DOIS case (mot e mot_st): depois dos tres terminais
  -- (quitado, liquidado, encerrado) e antes de tudo que e operacional.
  v_def := replace(v_def, v_anc_mot, v_anc_mot || '
                when e.f_giro then ''giro_fidelizado''');

  execute v_def;
end $mig$;

-- Rotulo do motivo novo na tela. Se a funcao nao existir ou nao tiver a
-- ancora, segue sem rotulo: o bloqueio ja esta feito e um texto ausente nao
-- justifica derrubar a migration.
do $mig$
declare
  v_def text;
  v_anc text := 'when ''encerrado_operacional''';
begin
  begin
    v_def := pg_get_functiondef('public.acoes_massivas_motivo_texto(text)'::regprocedure);
  exception when others then
    raise notice 'acoes_massivas_motivo_texto nao encontrada; rotulo nao adicionado.';
    return;
  end;
  if position('giro_fidelizado' in v_def) > 0 then return; end if;
  if position(v_anc in v_def) = 0 then
    raise notice 'ancora de rotulo nao encontrada; rotulo nao adicionado.';
    return;
  end if;
  execute replace(v_def, v_anc,
    'when ''giro_fidelizado'' then ''Fidelizado pelo giro de carteira (até 26/10/2026)''
    ' || v_anc);
end $mig$;

-- 2d. assumir_caso_livre(uuid) -- a partir de 27/10 qualquer operador ativo
--     pode assumir um caso do giro pelo fluxo normal, mesmo ele tendo dono, e
--     SEM depender da janela de 10 dias. Ate 26/10 a fidelizacao recusa.
--     Quem assume LIMPA a marca: o caso volta inteiro a regra normal.
do $mig$
declare
  v_def text := pg_get_functiondef('public.assumir_caso_livre(uuid)'::regprocedure);
  v_msg text := 'Este caso ja foi assumido por outro operador.';
  v_ancora text := 'return query select false,''Este caso ja foi assumido por outro operador.'',null::uuid; return;';
  v_novo text :=
    'if public.caso_em_giro_fidelizacao(v_new.giro_fidelizacao_ate) then
      return query select false,''Este caso está fidelizado pelo giro de carteira até 26/10/2026.'',null::uuid; return;
    end if;
    if v_new.giro_fidelizacao_ate is null then
      return query select false,''Este caso ja foi assumido por outro operador.'',null::uuid; return;
    end if;
    -- Caso de giro com a fidelizacao ja vencida: segue adiante e troca o dono.';
begin
  if position('giro_fidelizacao' in v_def) > 0 then
    raise notice 'assumir_caso_livre ja conhece o giro; nada a fazer.';
    return;
  end if;
  if position(v_msg in v_def) = 0 then
    raise exception 'assumir_caso_livre: mensagem de caso ja assumido nao encontrada';
  end if;
  if position(v_ancora in v_def) = 0 then
    raise exception 'assumir_caso_livre: a linha da recusa mudou de forma; conferir o texto antes de aplicar';
  end if;
  execute replace(v_def, v_ancora, v_novo);
end $mig$;

-- Quem assume um caso de giro limpa a marca, devolvendo-o a regra normal.
-- Gatilho proprio em vez de patch: assumir_caso_livre tem variantes (por aluno)
-- e um gatilho cobre todas sem reescrever nenhuma.
create or replace function public.giro_limpar_marca_ao_trocar_dono()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  -- So quando o caso TROCA de dono para outro operador, e so depois que a
  -- fidelizacao excepcional venceu. Trocar de dono durante a fidelizacao nao
  -- acontece pelo fluxo normal (a guarda recusa), e se acontecer por acao de
  -- gestao a marca tambem sai -- o caso deixou de ser do giro.
  if NEW.operador_email is not null
     and NEW.operador_email is distinct from OLD.operador_email
     and OLD.giro_fidelizacao_ate is not null
     -- ... e desde que o proprio UPDATE nao esteja gravando a marca. Sem isto,
     -- um segundo giro limparia a marca que ele mesmo acabou de pôr.
     and NEW.giro_fidelizacao_ate is not distinct from OLD.giro_fidelizacao_ate then
    NEW.giro_fidelizacao_ate := null;
  end if;
  return NEW;
end;
$$;

drop trigger if exists trg_giro_limpar_marca on public.casos;
create trigger trg_giro_limpar_marca
  before update on public.casos
  for each row
  when (NEW.operador_email is distinct from OLD.operador_email)
  execute function public.giro_limpar_marca_ao_trocar_dono();

-- NAO PATCHADO, com motivo declarado: nivelamento_automatico_gestao(int,
-- boolean, text[]) ja tem guarda de fidelizacao desde 29/09 e monta o pool a
-- partir de p_origens, cujo padrao e a base da gestao -- nao a carteira dos
-- operadores. Para alcancar caso de operador alguem precisa passar o e-mail
-- dele explicitamente, o que e acao humana, nao automacao. Patchar uma funcao
-- cujo corpo nao foi lido inteiro seria pior do que declarar o limite.


-- ===========================================================================
-- 3. SIMULACAO DO GIRO (nao move nada; grava RASCUNHO)
-- ===========================================================================
create or replace function public.giro_2026_10_simular(p_criterio jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_fid_ate date := coalesce(nullif(p_criterio->>'fidelizacao_ate','')::date, date '2026-10-26');
  v_metodo  text := coalesce(nullif(p_criterio->>'semestre_metodo',''), 'hibrido');
  v_ops     text[];
  v_n_ops   int;
  v_sim_id  uuid;
  v_res     jsonb;
begin
  if not (public.calibragem_e_gestao() or auth.jwt() is null) then
    raise exception 'Sem permissão para simular o giro de carteira.'
      using errcode = '42501';
  end if;
  if v_metodo not in ('hibrido','vencimento') then
    raise exception 'semestre_metodo deve ser hibrido ou vencimento (recebido: %).', v_metodo;
  end if;

  if p_criterio ? 'operadores' then
    v_ops := array(select jsonb_array_elements_text(p_criterio->'operadores'));
    if array_length(v_ops,1) is null then v_ops := null; end if;
  end if;

  -- Operadores que recebem, em ordem estavel (o slot 0 e sempre o mesmo e-mail).
  -- recebe_novos_casos entra no filtro: quem esta marcado para nao receber caso
  -- novo nao recebe fatia de giro.
  create temp table _ops on commit drop as
  select row_number() over (order by u.email) - 1 as slot, u.email, u.nome
    from public.usuarios u
   where u.ativo and u.perfil = 'operador'
     and coalesce(u.recebe_novos_casos, true)
     and (v_ops is null or u.email = any(v_ops));
  select count(*) into v_n_ops from _ops;
  if v_n_ops = 0 then raise exception 'Nenhum operador ativo para receber o giro.'; end if;

  -- Universo: MENSALIDADE em aberto, sem acordo. tipo_boleto 'Acordo' e parcela
  -- renegociada que virou titulo, nao mensalidade. Honorario nao e titulo (vive
  -- como valor_honorario em pagamentos), logo nao entra por construcao.
  -- Valor pela mesma formula da view calibragem_saldo_aluno, para o giro nao
  -- inventar mais uma formula de saldo.
  create temp table _tit on commit drop as
  select t.id, t.aluno_id,
         round(coalesce(t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0), 2) valor,
         case when v_metodo = 'vencimento' then null else ps.semestre end sem_prime,
         case when t.vencimento >= date '2026-01-01' and t.vencimento < date '2026-07-01' then '2026/1'
              when t.vencimento >= date '2026-07-01' and t.vencimento < date '2027-01-01' then '2026/2'
         end sem_venc
    from public.acordos_titulos t
    left join public.prime_titulo_semestre ps on ps.boleto = t.documento
   where upper(coalesce(t.situacao,'')) = 'ABERTO'
     and lower(coalesce(t.status,'')) = 'em_aberto'
     and t.acordo_id is null
     and coalesce(t.tipo_boleto,'') <> 'Acordo'
     and not exists (select 1 from public.acordo_titulo_vinculo v
                      where v.titulo_id = t.id and coalesce(v.ativo, true))
     and not public.titulo_superado_por_acordo(t.aluno_id, t.vencimento);

  create temp table _uni on commit drop as
  select id, aluno_id, valor, coalesce(sem_prime, sem_venc) semestre
    from _tit
   where coalesce(sem_prime, sem_venc) in ('2026/1','2026/2')
     and valor > 0 and aluno_id is not null;

  create temp table _aluno on commit drop as
  select aluno_id, count(*) titulos, round(sum(valor),2) saldo,
         count(*) filter (where semestre = '2026/1') t1,
         count(*) filter (where semestre = '2026/2') t2,
         round(coalesce(sum(valor) filter (where semestre = '2026/1'),0),2) v1,
         round(coalesce(sum(valor) filter (where semestre = '2026/2'),0),2) v2
    from _uni group by aluno_id;

  -- Aluno com parcela de acordo em aberto fica FORA do giro inteiro: mover o
  -- caso dele brigaria com a regra "o dono do acordo e o responsavel" (13/09).
  -- Mesmas condicoes da view calibragem_saldo_aluno, calculadas so para os
  -- candidatos -- a view recalcula a base toda e estoura o tempo.
  create temp table _acordo on commit drop as
  select a.aluno_id
    from public.parcelas p join public.acordos a on a.id = p.acordo_id
   where a.aluno_id in (select aluno_id from _aluno)
     and lower(coalesce(a.status,'')) not in ('cancelado','cancelada')
     and upper(coalesce(p.status,'')) not in ('PAGO','PAGA','CANCELADA','CANCELADO','ESTORNADA','ESTORNADO')
   group by a.aluno_id;

  -- CPF vazio vira chave propria do caso: colapsar os vazios num bucket unico
  -- inventaria um "aluno" gigante.
  create temp table _caso on commit drop as
  select c.id caso_id, c.aluno_id,
         c.operador_email de_email, c.operador_nome de_nome,
         coalesce(c.nome, c.nome_aluno) nome, coalesce(c.cpf_limpo, c.cpf) cpf,
         coalesce(nullif(regexp_replace(coalesce(c.cpf_limpo, c.cpf, ''), '\D', '', 'g'), ''),
                  'caso:' || c.id::text) cpf_caso,
         public.caso_protegido_redistribuicao(c.cpf_limpo, c.status_acionamento, c.nao_acionar,
           c.status_financeiro, c.valor_pago, c.quitado_em, c.valor_quitado) protegido,
         public.caso_encerrado_operacional(c.cpf_limpo, c.status_atual, c.status_acionamento,
           c.status_financeiro, c.status_jornada) encerrado
    from public.casos c
   where c.aluno_id in (select aluno_id from _aluno);

  create temp table _chave on commit drop as
  select aluno_id, min(cpf_caso) cpf_chave from _caso group by aluno_id;

  create temp table _elegivel on commit drop as
  select a.aluno_id, a.titulos, a.saldo, a.t1, a.t2, a.v1, a.v2, k.cpf_chave
    from _aluno a join _chave k on k.aluno_id = a.aluno_id
   where a.aluno_id not in (select aluno_id from _acordo)
     and exists (select 1 from _caso c
                  where c.aluno_id = a.aluno_id and not c.protegido and not c.encerrado);

  -- Soma por ALUNO_ID distinto: ficha duplicada nao conta o saldo duas vezes.
  create temp table _cpf on commit drop as
  select cpf_chave, round(sum(saldo),2) valor, sum(titulos) titulos,
         round(sum(v1),2) s1, round(sum(v2),2) s2,
         bool_or(t1 > 0) tem1, bool_or(t2 > 0) tem2
    from _elegivel group by cpf_chave;

  -- DUAS PASSADAS, prioridade 2026/2 (decisao da gestao em 16/10/2026).
  --
  -- Uma serpentina unica pelo saldo TOTAL equilibra o total e deixa a safra
  -- solta: medido em 16/10, 2026/2 abria 13,6% entre o maior e o menor. Por
  -- isso:
  --   A) os CPFs com divida em 2026/2 entram primeiro, em serpentina pelo
  --      saldo DE 2026/2 -- a safra fica equilibrada em valor e em quantidade
  --      por construcao;
  --   B) os CPFs so de 2026/1 entram por COTA: cada operador recebe exatamente
  --      o que falta para fechar a contagem alvo (base para todos, +1 para os
  --      `rem` primeiros), e a ordem das vagas ALTERNA a cada rodada entre
  --      menor e maior saldo acumulado. E essa alternancia que recupera o
  --      equilibrio do consolidado sem desfazer o de 2026/2.
  --
  -- Sem a cota, as duas passadas somam dois arredondamentos e a diferenca de
  -- CPFs vira 2; sem a alternancia, o consolidado abre para 2,8%. Com as duas:
  -- CPFs 543-544, 2026/2 em 1,49% e consolidado em 1,45% (medido).
  alter table _cpf add column slot int;

  -- Passada A -- 2026/2 manda.
  with fila as (
    select cpf_chave, row_number() over (order by s2 desc, cpf_chave) - 1 r
      from _cpf where tem2
  )
  update _cpf c
     set slot = case when (f.r / v_n_ops) % 2 = 0
                     then  f.r % v_n_ops
                     else  v_n_ops - 1 - (f.r % v_n_ops) end
    from fila f where f.cpf_chave = c.cpf_chave;

  -- Passada B -- 2026/1 complementa, por cota e com alternancia.
  with tot_a as (
    select o.slot, coalesce(sum(c.valor),0) t, count(c.cpf_chave) q
      from _ops o left join _cpf c on c.slot = o.slot group by o.slot
  ), par as (
    select count(*) n, count(*) / v_n_ops base, count(*) % v_n_ops rem from _cpf
  ), alvo as (
    select slot, q, t,
           (select base from par)
           + case when row_number() over (order by t asc) <= (select rem from par)
                  then 1 else 0 end tgt
      from tot_a
  ), vagas as (
    select slot, t, generate_series(1, tgt - q) k from alvo where tgt - q > 0
  ), vagas_ord as (
    select slot, row_number() over (
             order by k asc, case when k % 2 = 1 then t else -t end asc) - 1 pos
      from vagas
  ), fila_b as (
    select cpf_chave, row_number() over (order by s1 desc, cpf_chave) - 1 r
      from _cpf where not tem2
  )
  update _cpf c set slot = v.slot
    from fila_b f join vagas_ord v on v.pos = f.r
   where f.cpf_chave = c.cpf_chave;

  -- Nenhum CPF pode sair sem operador: se a cota nao cobrir a fila, para aqui
  -- em vez de perder gente em silencio no join com _ops.
  if exists (select 1 from _cpf where slot is null) then
    raise exception 'Giro: % CPFs ficaram sem operador na distribuição.',
      (select count(*) from _cpf where slot is null);
  end if;

  -- Uma movimentacao por CASO LIVRE do CPF: caso protegido ou encerrado nao se
  -- mexe, mesmo quando o CPF entra no giro.
  create temp table _mov on commit drop as
  select ca.caso_id, ca.cpf, ca.nome, cp.valor, ca.de_email, ca.de_nome,
         cp.cpf_chave, o.email para_email, o.nome para_nome,
         case when cp.tem1 and cp.tem2 then 'Giro 2026/1 e 2026/2'
              when cp.tem1 then 'Giro 2026/1' else 'Giro 2026/2' end
         || case when ca.de_email is null then ': recebido do pool'
                 else ': carteira redistribuída' end motivo
    from _caso ca
    join _chave k  on k.aluno_id = ca.aluno_id
    join _cpf  cp  on cp.cpf_chave = k.cpf_chave
    join _ops  o   on o.slot = cp.slot
   where not ca.protegido and not ca.encerrado
     and ca.aluno_id in (select aluno_id from _elegivel);

  -- Subconsultas por slot, nunca dois left join na mesma linha: juntar _mov e
  -- _cpf de uma vez cruzaria caso com CPF e multiplicaria casos e saldo.
  -- Quanto cada operador fica com carteira ATIVA depois do giro -- a mesma
  -- conta que trg_impor_teto_operador faz (fora protegidos e encerrados).
  -- Serve para o executor recusar o giro se o teto nao comportar o resultado.
  create temp table _teto on commit drop as
  select o.email op_email, o.nome op_nome,
         (select count(*) from public.casos c
           where c.operador_email = o.email
             and not public.caso_protegido_redistribuicao(c.cpf_limpo, c.status_acionamento,
                   c.nao_acionar, c.status_financeiro, c.valor_pago, c.quitado_em, c.valor_quitado)
             and not public.caso_encerrado_operacional(c.cpf_limpo, c.status_atual,
                   c.status_acionamento, c.status_financeiro, c.status_jornada)) ativos_hoje,
         (select count(*) from _mov m where m.de_email = o.email) saem,
         (select count(*) from _mov m where m.para_email = o.email) entram,
         public.calibragem_teto_operador(o.email) teto_atual
    from _ops o;

  create temp table _depois on commit drop as
  select o.email op_email, o.nome op_nome,
         (select count(*) from _cpf c where c.slot = o.slot) cpfs,
         (select count(*) from _cpf c where c.slot = o.slot and c.tem1) cpfs_2026_1,
         (select count(*) from _cpf c where c.slot = o.slot and c.tem2) cpfs_2026_2,
         (select coalesce(sum(c.titulos),0) from _cpf c where c.slot = o.slot) titulos,
         (select count(*) from _mov m where m.para_email = o.email) casos,
         (select round(coalesce(sum(c.s1),0),2) from _cpf c where c.slot = o.slot) saldo_2026_1,
         (select round(coalesce(sum(c.s2),0),2) from _cpf c where c.slot = o.slot) saldo_2026_2,
         (select round(coalesce(sum(c.valor),0),2) from _cpf c where c.slot = o.slot) saldo
    from _ops o;

  select jsonb_build_object(
    'metrica', 'GIRO_2026_10',
    'criterio', p_criterio,
    'semestre_metodo', v_metodo,
    'fidelizacao_ate', v_fid_ate,
    'operadores', v_n_ops,
    'ignora_fidelizacao_de_10_dias', true,
    'universo', jsonb_build_object(
      'alunos',  (select count(*) from _aluno),
      'titulos', (select sum(titulos) from _aluno),
      'saldo',   (select round(sum(saldo),2) from _aluno)),
    'fora_do_giro', jsonb_build_object(
      'acordo_ativo', (select count(*) from _aluno where aluno_id in (select aluno_id from _acordo)),
      'sem_ficha_no_crm', (select count(*) from _aluno a
                            where a.aluno_id not in (select aluno_id from _acordo)
                              and a.aluno_id not in (select aluno_id from _chave)),
      'caso_protegido_ou_encerrado', (select count(*) from _aluno a
                            where a.aluno_id not in (select aluno_id from _acordo)
                              and a.aluno_id in (select aluno_id from _chave)
                              and a.aluno_id not in (select aluno_id from _elegivel))),
    'distribuido', jsonb_build_object(
      'cpfs',    (select count(*) from _cpf),
      'titulos', (select sum(titulos) from _cpf),
      'saldo',   (select round(sum(valor),2) from _cpf),
      'casos',   (select count(*) from _mov)),
    'por_operador', (select coalesce(jsonb_agg(jsonb_build_object(
        'op_email', d.op_email, 'op_nome', d.op_nome, 'cpfs', d.cpfs,
        'cpfs_2026_1', d.cpfs_2026_1, 'cpfs_2026_2', d.cpfs_2026_2,
        'titulos', d.titulos, 'casos', d.casos,
        'saldo_2026_1', d.saldo_2026_1, 'saldo_2026_2', d.saldo_2026_2,
        'saldo', d.saldo) order by d.op_nome), '[]')
      from _depois d),
    'equilibrio', jsonb_build_object(
      'dif_cpfs',  (select max(cpfs) - min(cpfs) from _depois),
      'dif_cpfs_2026_2', (select max(cpfs_2026_2) - min(cpfs_2026_2) from _depois),
      'dif_saldo', (select round(max(saldo) - min(saldo),2) from _depois),
      'dif_saldo_pct', (select round(100.0*(max(saldo)-min(saldo))/nullif(max(saldo),0),2) from _depois),
      'dif_saldo_2026_2_pct', (select round(100.0*(max(saldo_2026_2)-min(saldo_2026_2))/nullif(max(saldo_2026_2),0),2) from _depois),
      'dif_saldo_2026_1_pct', (select round(100.0*(max(saldo_2026_1)-min(saldo_2026_1))/nullif(max(saldo_2026_1),0),2) from _depois),
      -- Checagens de verdade, nao tautologia: o CPF chega a um operador so, e o
      -- saldo distribuido fecha com o saldo dos alunos elegiveis (duas tabelas
      -- diferentes, nao a mesma soma dos dois lados).
      'cpf_em_mais_de_um_operador', (select count(*) from
        (select cpf_chave from _mov group by cpf_chave having count(distinct para_email) > 1) z),
      'caso_em_duplicidade', (select count(*) from
        (select caso_id from _mov group by caso_id having count(*) > 1) z),
      'soma_fecha', (select round(sum(valor),2) from _cpf)
                    is not distinct from (select round(sum(saldo),2) from _elegivel)),
    'teto', jsonb_build_object(
      'necessario', (select max(ativos_hoje - saem + entram) from _teto),
      'menor_teto_atual', (select min(teto_atual) from _teto),
      'por_operador', (select coalesce(jsonb_agg(jsonb_build_object(
          'op_email', op_email, 'op_nome', op_nome, 'ativos_hoje', ativos_hoje,
          'saem', saem, 'entram', entram,
          'ativos_depois', ativos_hoje - saem + entram,
          'teto_atual', teto_atual) order by op_nome), '[]') from _teto)),
    -- Quem muda de mao, antes de mexer em nada. Por CPF, nao por caso: as
    -- fichas do mesmo CPF vao todas para o mesmo operador.
    'movimento', (select jsonb_build_object(
        'cpfs_vindos_do_pool',        count(*) filter (where sem_dono),
        'cpfs_que_trocam_de_operador', count(*) filter (where not sem_dono and not mesmo),
        'cpfs_que_ficam_com_o_mesmo',  count(*) filter (where mesmo))
      from (select cpf_chave,
                   bool_and(de_email is null) sem_dono,
                   bool_and(de_email is not distinct from para_email) mesmo
              from _mov group by cpf_chave) z),
    'movimentacoes', (select coalesce(jsonb_agg(jsonb_build_object(
        'caso_id', caso_id, 'cpf', cpf, 'nome', nome, 'valor', valor,
        'de_email', de_email, 'de_nome', de_nome,
        'para_email', para_email, 'para_nome', para_nome, 'motivo', motivo)
        order by para_email, valor desc), '[]') from _mov),
    'total_movimentacoes', (select count(*) from _mov)
  ) into v_res;

  insert into public.calibragem_simulacoes(criado_por_email, criado_por_nome, criterios, resultado, status)
  values (coalesce(auth.jwt()->>'email','server'), coalesce(auth.jwt()->>'email','server'),
          p_criterio || jsonb_build_object('tipo','GIRO_2026_10'), v_res, 'RASCUNHO')
  returning id into v_sim_id;

  return jsonb_build_object('simulacao_id', v_sim_id) || v_res;
end;
$$;

alter function public.giro_2026_10_simular(jsonb) set statement_timeout to '180s';

comment on function public.giro_2026_10_simular(jsonb) is
  'Giro 16/10/2026: divide as mensalidades 2026/1 e 2026/2 em partes iguais '
  '(CPFs e valor) entre os operadores ativos. Nao move nada: grava RASCUNHO em '
  'calibragem_simulacoes. Criterios: semestre_metodo (hibrido|vencimento), '
  'fidelizacao_ate (default 2026-10-26), operadores (lista de e-mails).';


-- ===========================================================================
-- 4. EXECUCAO EM LOTES (so de simulacao APROVADA)
-- ===========================================================================
create or replace function public.giro_2026_10_executar_lote_impl(p_id uuid, p_tamanho int default 150)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_sim record; v_email text := coalesce(auth.jwt() ->> 'email','server');
  v_fid_ate date; v_movidos int := 0; v_pulados int := 0;
  v_total int; v_feitos int; v_restantes int; v_teto_necessario int;
begin
  if not (public.calibragem_e_gestao() or auth.jwt() is null) then
    raise exception 'Sem permissão para executar o giro de carteira.'
      using errcode = '42501';
  end if;
  if p_tamanho is null or p_tamanho < 1 then p_tamanho := 150; end if;

  select * into v_sim from public.calibragem_simulacoes where id = p_id for update;
  if not found then raise exception 'Simulação % não encontrada.', p_id; end if;
  if coalesce(v_sim.resultado->>'metrica','') <> 'GIRO_2026_10' then
    raise exception 'Esta simulação não é o giro de 16/10/2026.';
  end if;
  if v_sim.status not in ('APROVADA','EXECUTANDO') then
    raise exception 'Simulação precisa estar APROVADA ou EXECUTANDO (atual: %).', v_sim.status;
  end if;
  v_fid_ate := coalesce(nullif(v_sim.resultado->>'fidelizacao_ate','')::date, date '2026-10-26');

  -- O teto precisa comportar a carteira que o giro produz. Se nao comportar, o
  -- gatilho de teto devolveria o excedente ao pool na primeira troca de dono --
  -- e o giro se desfaria em parte, em silencio. Conferido a cada lote, de
  -- proposito: protege tambem contra o teto ser baixado no meio da execucao.
  v_teto_necessario := coalesce((v_sim.resultado->'teto'->>'necessario')::int, 0);
  if exists (
    select 1 from jsonb_array_elements(v_sim.resultado->'por_operador') o
     where public.calibragem_teto_operador(o->>'op_email') < v_teto_necessario)
  then
    raise exception 'Teto da carteira abaixo do necessário para este giro (%). Ajuste com calibragem_definir_teto antes de executar.', v_teto_necessario
      using errcode = '42501';
  end if;

  -- Mesma trava do nivelamento: aplicar e desfazer nunca correm juntos.
  perform pg_advisory_xact_lock(hashtext('calibragem_executar_nivelamento'));
  if v_sim.status = 'APROVADA' then
    update public.calibragem_simulacoes set status = 'EXECUTANDO' where id = p_id;
  end if;

  select count(distinct (m->>'caso_id')) into v_total
    from jsonb_array_elements(v_sim.resultado->'movimentacoes') m;

  -- O teto de 500 nao arbitra o giro: a carteira alvo e maior que ele por
  -- desenho. Ver RUNBOOK passo 2.
  perform set_config('calibragem.bypass_teto','on', true);

  create temp table _slice on commit drop as
  select (m->>'caso_id')::uuid caso_id, nullif(m->>'de_email','') de_email, m->>'de_nome' de_nome,
         nullif(m->>'para_email','') para_email, m->>'para_nome' para_nome,
         (m->>'valor')::numeric valor, m->>'motivo' motivo, m->>'cpf' cpf, m->>'nome' nome,
         false as valido
    from jsonb_array_elements(v_sim.resultado->'movimentacoes') m
   where not exists (
     select 1 from public.calibragem_auditoria a
      where a.simulacao_id = p_id and a.caso_id = (m->>'caso_id')::uuid
        and a.evento in ('MOVIMENTACAO_NIVELAMENTO','PULADO_NIVELAMENTO'))
   order by (m->>'caso_id')
   limit p_tamanho;

  -- Revalida no momento da aplicacao: o caso pode ter mudado de dono ou ficado
  -- protegido entre a simulacao e agora. A janela de 10 dias NAO e testada --
  -- girar e justamente o ponto.
  update _slice e set valido = true from public.casos c
   where c.id = e.caso_id
     and c.operador_email is not distinct from e.de_email
     and not public.caso_protegido_redistribuicao(c.cpf_limpo, c.status_acionamento, c.nao_acionar,
           c.status_financeiro, c.valor_pago, c.quitado_em, c.valor_quitado)
     and not public.caso_encerrado_operacional(c.cpf_limpo, c.status_atual, c.status_acionamento,
           c.status_financeiro, c.status_jornada);

  -- Responsavel do caso + titularidade da mensalidade + fidelizacao do giro,
  -- num UPDATE so. alunos.responsavel_atual_email segue por trg_sync_alunos_apos_casos.
  update public.casos c
     set operador_email = e.para_email,
         operador_nome  = e.para_nome,
         operador       = upper(coalesce(e.para_nome,'')),
         operador_mensalidade_email = e.para_email,
         operador_mensalidade_nome  = e.para_nome,
         mensalidade_girada_em = now(),
         giro_fidelizacao_ate  = v_fid_ate
    from _slice e
   where e.valido and c.id = e.caso_id and e.para_email is not null;

  insert into public.calibragem_auditoria(evento, simulacao_id, caso_id, aluno_id, cpf, nome_aluno,
    operador_anterior_email, operador_anterior_nome, operador_novo_email, operador_novo_nome,
    valor_caso, motivo, regra, situacao_anterior, situacao_posterior,
    aprovado_por_email, aprovado_por_nome, registrado_por_email)
  select 'MOVIMENTACAO_NIVELAMENTO', p_id, e.caso_id, c.aluno_id, e.cpf, e.nome,
    e.de_email, e.de_nome, e.para_email, e.para_nome, e.valor, e.motivo, 'GIRO_2026_10',
    jsonb_build_object('operador_email', e.de_email, 'operador_nome', e.de_nome),
    jsonb_build_object('operador_email', e.para_email, 'operador_nome', e.para_nome,
                       'giro_fidelizacao_ate', v_fid_ate),
    v_sim.aprovado_por_email, v_sim.aprovado_por_nome, v_email
    from _slice e join public.casos c on c.id = e.caso_id where e.valido;
  get diagnostics v_movidos = row_count;

  insert into public.calibragem_auditoria(evento, simulacao_id, caso_id, aluno_id, cpf, nome_aluno,
    operador_anterior_email, operador_anterior_nome, operador_novo_email, operador_novo_nome,
    valor_caso, motivo, regra, situacao_anterior, situacao_posterior,
    aprovado_por_email, aprovado_por_nome, registrado_por_email)
  select 'PULADO_NIVELAMENTO', p_id, e.caso_id, c.aluno_id, e.cpf, e.nome,
    e.de_email, e.de_nome, e.para_email, e.para_nome, e.valor,
    'Pulado no giro: o caso já não pertence ao operador de origem ou ficou protegido (negociação, acordo, link, termo, pagamento).',
    'GIRO_2026_10', '{}'::jsonb, '{}'::jsonb,
    v_sim.aprovado_por_email, v_sim.aprovado_por_nome, v_email
    from _slice e left join public.casos c on c.id = e.caso_id where not e.valido;
  get diagnostics v_pulados = row_count;

  select count(distinct a.caso_id) into v_feitos
    from public.calibragem_auditoria a
   where a.simulacao_id = p_id and a.evento in ('MOVIMENTACAO_NIVELAMENTO','PULADO_NIVELAMENTO');
  v_restantes := greatest(v_total - v_feitos, 0);

  if v_restantes = 0 then
    update public.calibragem_simulacoes set status = 'EXECUTADA', executado_em = now() where id = p_id;
  end if;

  return jsonb_build_object('id', p_id, 'movidos_lote', v_movidos, 'pulados_lote', v_pulados,
    'feitos', v_feitos, 'restantes', v_restantes, 'total', v_total, 'concluido', v_restantes = 0);
end;
$$;

create or replace function public.giro_2026_10_executar_lote(p_id uuid, p_tamanho int default 150)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  perform public.exigir_capacidade('executar giro de carteira em lote');
  return public.giro_2026_10_executar_lote_impl(p_id, p_tamanho);
end;
$$;

alter function public.giro_2026_10_executar_lote_impl(uuid, int) set statement_timeout to '180s';

revoke all on function public.giro_2026_10_simular(jsonb) from public, anon, authenticated;
revoke all on function public.giro_2026_10_executar_lote(uuid, int) from public, anon, authenticated;
revoke all on function public.giro_2026_10_executar_lote_impl(uuid, int) from public, anon, authenticated;
grant execute on function public.giro_2026_10_simular(jsonb) to authenticated;
grant execute on function public.giro_2026_10_executar_lote(uuid, int) to authenticated;

comment on function public.giro_2026_10_executar_lote(uuid, int) is
  'Aplica em lotes uma simulação GIRO_2026_10 APROVADA. Ignora a janela de 10 '
  'dias (é o ponto do giro); as demais proteções continuam valendo. Grava a '
  'fidelização excepcional em casos.giro_fidelizacao_ate. '
  'Desfazer: calibragem_desfazer_nivelamento_lote.';


-- ===========================================================================
-- 5. TETO DA CARTEIRA: 500 -> 700 (decisao da gestao em 16/10/2026)
-- ===========================================================================
-- POR QUE. trg_impor_teto_operador libera o excedente acima do teto a cada
-- troca de dono, escolhendo os casos de menor valor em aberto fora da janela de
-- 10 dias. Medido em 16/10, a carteira ATIVA depois do giro: Allan 626, Diego
-- 634, João 613, Luana 568, Mauricio 599, Nataly 592, Rafaella 609 -- os sete
-- acima de 500. A guarda da secao 2b impede que o gatilho escolha caso girado,
-- mas o excedente nao some: cairia sobre a carteira antiga do operador (de 11 a
-- 67 casos cada), esvaziando-a na primeira atribuicao.
--
-- 700 deixa 66 de folga sobre o maior caso medido (634). A funcao aceita de 50
-- a 3000 e exige gestao OU auth.jwt() nulo -- por isso roda em migration.
--
-- ESTADO ANTERIOR, para reverter: calibragem_parametros.limite_carteira = 500,
-- gravado por 'migration' em 2026-07-30 23:34:05 UTC.
-- Reverter: select public.calibragem_definir_teto(500, null);
--
-- Isto muda a regra geral de TODAS as carteiras, nao so as deste giro -- e a
-- unica coisa neste arquivo que faz isso, e esta aqui porque sem ela o giro
-- nao para de pe.
select public.calibragem_definir_teto(700, null);


-- ===========================================================================
-- RUNBOOK -- nada abaixo roda sozinho; cada passo e uma decisao da gestao.
-- ===========================================================================
--
-- 1. SIMULAR e conferir contra docs/GIRO-CARTEIRAS-2026-1-2026-2-SIMULACAO.md:
--      select public.giro_2026_10_simular('{}'::jsonb);
--    Conferir em 'equilibrio': dif_cpfs, cpf_em_mais_de_um_operador (deve ser
--    0) e soma_fecha (deve ser true). Guardar o simulacao_id.
--
-- 2. TETO -- ja resolvido pela secao 5 desta migration (700). Conferir que
--    pegou, e que o bloco 'teto' da simulacao nao pede mais do que isso:
--      select public.calibragem_teto_operador('cobranca11@aelbra.com.br');
--    O executor recusa o giro se qualquer operador estiver com teto abaixo do
--    necessario, entao este passo e conferencia, nao acao.
--    ATENCAO para depois: se o teto voltar a 500 enquanto a carteira estiver
--    nesse tamanho, o excedente volta a ser liberado na primeira troca de dono
--    -- cerca de 740 casos de volta ao pool. O numero 700 e definitivo ate a
--    gestao decidir outro, nao um provisorio que expira em 26/10.
--
-- 3. APROVAR:
--      update public.calibragem_simulacoes
--         set status = 'APROVADA', aprovado_por_email = '<seu e-mail>',
--             aprovado_por_nome = '<seu nome>'
--       where id = '<simulacao_id>';
--
-- 4. EXECUTAR em lotes ate 'concluido' ser true (cerca de 27 lotes de 150):
--      select public.giro_2026_10_executar_lote_impl('<simulacao_id>', 150);
--
-- 5. CONFERIR depois do ultimo lote:
--      select count(*) filter (where evento = 'MOVIMENTACAO_NIVELAMENTO') movidos,
--             count(*) filter (where evento = 'PULADO_NIVELAMENTO') pulados
--        from public.calibragem_auditoria where simulacao_id = '<simulacao_id>';
--      select count(*) from public.casos where giro_fidelizacao_ate = date '2026-10-26';
--      select public.carteira_geral_vigia();
--
-- 6. DESFAZER, se precisar (devolve cada caso ao dono anterior da auditoria):
--      select public.calibragem_desfazer_nivelamento_lote('<simulacao_id>', 150);
--    Repetir ate zerar. A fidelizacao do giro NAO e limpa pelo desfazer; para
--    limpar: update public.casos set giro_fidelizacao_ate = null
--              where giro_fidelizacao_ate = date '2026-10-26';
--
-- 7. DEPOIS DE 26/10: nada vence sozinho, nenhuma rotina dispara, nenhum caso
--    volta ao pool. O que muda a partir de 27/10, sem ninguem rodar nada:
--      * o aluno volta a aparecer nas acoes massivas (a flag olha a data);
--      * qualquer operador ativo pode assumir o caso pelo fluxo normal, mesmo
--        ele tendo dono, e sem depender da janela de 10 dias;
--      * ate alguem assumir, o responsavel e o historico seguem intactos;
--      * quem assume limpa a marca, e o caso volta inteiro a regra normal.
--
-- 8. CONFERENCIAS da virada (rodar em 27/10, so leitura):
--      select count(*) from public.casos where giro_fidelizacao_ate is not null;
--      select count(*) from public.acoes_massivas_universo(
--        jsonb_build_object('canal','WHATSAPP')) where mot_st = 'giro_fidelizado';
--    O segundo deve ser 0 a partir de 27/10 e maior que zero antes disso.
