-- PREVENTIVO: histórico de acoes feitas FORA do CRM.
--
-- O QUE MUDOU NA REALIDADE DA OPERACAO. As acoes do Preventivo estao sendo
-- disparadas por fora -- e-mail e WhatsApp a partir do proprio relatorio de
-- inadimplencia. O modulo so sabia registrar o que nascia dentro dele, entao o
-- historico e a efetividade dessas acoes ficavam de fora.
--
-- DUAS PECAS, SO ISSO:
--
--   1. DATA REAL DA EXTRACAO na remessa. `criado_em` e o momento do upload;
--      para registrar o passado e para ordenar fotos tiradas em dias
--      diferentes, o que vale e QUANDO O RELATORIO FOI EXTRAIDO. Toda
--      comparacao entre remessas passa a usar `extraido_em`.
--
--   2. ACAO EXTERNA. Registra canal, contexto, data real do envio e o publico
--      -- que e a propria remessa, porque o arquivo enviado E a lista. Nasce
--      ja com `origem = 'EXTERNA'` e estado ENVIO_CONFIRMADO, porque o envio
--      ja aconteceu. A marca EXTERNA e visivel na tela e no relatorio: o
--      modulo NUNCA finge que foi ele quem enviou.
--
-- O QUE NAO MUDA: importacao, janela de 31 dias, sincronizacao com o Prime,
-- elegibilidade e a maquina de estados. A palavra tambem nao muda -- o titulo
-- que some entre remessas SAIU DA BASE, sem confirmacao de pagamento.

-- -----------------------------------------------------------------------------
-- 1. DATA REAL DA EXTRACAO
-- -----------------------------------------------------------------------------
alter table public.prev_lote add column if not exists extraido_em timestamptz;

-- Remessa que ja existe foi importada no dia da extracao: o proprio criado_em
-- e a melhor verdade disponivel. Nenhum valor e inventado.
update public.prev_lote set extraido_em = criado_em where extraido_em is null;

alter table public.prev_lote alter column extraido_em set default now();
alter table public.prev_lote alter column extraido_em set not null;

comment on column public.prev_lote.extraido_em is
  'Quando o relatorio foi EXTRAIDO na origem -- nao quando foi importado aqui '
  '(isso e `criado_em`). E esta data que ordena as remessas e define qual e a '
  'seguinte de cada acao. Permite registrar foto antiga sem inverter a ordem.';

create index if not exists prev_lote_extraido_idx
  on public.prev_lote (carteira_id, extraido_em);

-- -----------------------------------------------------------------------------
-- 2. ORIGEM DA ACAO
-- -----------------------------------------------------------------------------
alter table public.prev_acao add column if not exists origem text;
update public.prev_acao set origem = 'MODULO' where origem is null;
alter table public.prev_acao alter column origem set default 'MODULO';
alter table public.prev_acao alter column origem set not null;

alter table public.prev_acao drop constraint if exists prev_acao_origem_check;
alter table public.prev_acao add constraint prev_acao_origem_check
  check (origem in ('MODULO', 'EXTERNA'));

comment on column public.prev_acao.origem is
  'MODULO = preparada e exportada aqui. EXTERNA = o disparo aconteceu fora do '
  'CRM e foi apenas REGISTRADO, com data e publico informados por quem enviou. '
  'A tela e o relatorio mostram a marca: o modulo nunca finge que enviou.';

-- -----------------------------------------------------------------------------
-- 3. IMPORTAR COM A DATA DA EXTRACAO
-- -----------------------------------------------------------------------------
-- v2 porque a v1 de 6 argumentos continua viva durante o deploy. Ela NAO copia
-- a importacao: delega e carimba a data. CONSEQUENCIA A NAO ESQUECER: enquanto
-- a v2 existir, a v1 nao pode ser removida sem mover o corpo para dentro dela.
create or replace function public.preventivo_lote_confirmar_v2(
  p_carteira_id uuid, p_nome text, p_arquivo text, p_mapeamento jsonb,
  p_conteudo_hash text, p_linhas jsonb, p_extraido_em timestamptz)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare v jsonb; v_lote uuid;
begin
  if not public.preventivo_e_gestao() then
    raise exception 'Preventivo: acesso restrito à gestão.' using errcode = '42501';
  end if;
  if p_extraido_em is null then
    raise exception 'Informe a data em que o relatório foi extraído.' using errcode = '22023';
  end if;
  if p_extraido_em > now() + interval '1 day' then
    raise exception 'A extração não pode estar no futuro.' using errcode = '22023';
  end if;

  v := public.preventivo_lote_confirmar(p_carteira_id, p_nome, p_arquivo,
                                        p_mapeamento, p_conteudo_hash, p_linhas);
  v_lote := (v->>'lote_id')::uuid;
  update public.prev_lote set extraido_em = p_extraido_em where id = v_lote;

  return v || jsonb_build_object('extraido_em', p_extraido_em);
end;
$$;

-- -----------------------------------------------------------------------------
-- 4. REGISTRAR ACAO FEITA FORA DO CRM
-- -----------------------------------------------------------------------------
-- O PUBLICO NAO E PRESUMIDO. Quem registra ou informa a lista de matriculas
-- que recebeu (`p_matriculas`), ou declara explicitamente que o envio cobriu a
-- remessa inteira (`p_remessa_inteira`). Assumir que todo mundo da remessa foi
-- acionado inflaria a base da acao e, com ela, o resultado.
--
-- Matricula informada que nao esta na remessa e IGNORADA e devolvida em
-- `fora_da_remessa`: nao se inventa titulo que a foto nao tinha.
create or replace function public.preventivo_acao_externa_registrar(
  p_carteira_id uuid, p_lote_id uuid, p_nome text, p_canal text,
  p_contexto text, p_enviada_em timestamptz,
  p_matriculas text[] default null, p_remessa_inteira boolean default false)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_acao uuid; v_ctx text := upper(btrim(coalesce(p_contexto, '')));
  v_canal text := upper(btrim(coalesce(p_canal, ''))); v_extraido timestamptz;
  v_lista text[]; v_fora text[] := '{}'; v_publico text;
begin
  if not public.preventivo_e_gestao() then
    raise exception 'Preventivo: acesso restrito à gestão.' using errcode = '42501';
  end if;
  if coalesce(btrim(p_nome), '') = '' then
    raise exception 'Dê um nome à ação.' using errcode = '22023';
  end if;
  if v_canal not in ('WHATSAPP', 'EMAIL') then
    raise exception 'Canal inválido: use WHATSAPP ou EMAIL.' using errcode = '22023';
  end if;
  if v_ctx not in ('PROXIMO_VENCIMENTO', 'BOLETO_VENCIDO') then
    raise exception 'Contexto inválido: use PROXIMO_VENCIMENTO ou BOLETO_VENCIDO.' using errcode = '22023';
  end if;
  if p_enviada_em is null then
    raise exception 'Informe a data e hora do envio.' using errcode = '22023';
  end if;
  if p_enviada_em > now() + interval '1 day' then
    raise exception 'O envio não pode estar no futuro.' using errcode = '22023';
  end if;

  select extraido_em into v_extraido from public.prev_lote
   where id = p_lote_id and carteira_id = p_carteira_id and status = 'CONFIRMADO';
  if v_extraido is null then
    raise exception 'Remessa não encontrada nesta carteira.' using errcode = '22023';
  end if;
  if p_enviada_em < v_extraido then
    raise exception 'O envio (%) é anterior à extração da remessa (%).', p_enviada_em, v_extraido
      using errcode = '22023';
  end if;

  -- O publico: lista informada OU confirmacao explicita da remessa inteira.
  v_lista := (select array_agg(distinct btrim(m)) from unnest(coalesce(p_matriculas, '{}')) m
               where btrim(coalesce(m, '')) <> '');
  if v_lista is null and not coalesce(p_remessa_inteira, false) then
    raise exception 'Informe quem recebeu: a lista de matrículas, ou confirme que o envio cobriu a remessa inteira.'
      using errcode = '22023';
  end if;
  if v_lista is not null and coalesce(p_remessa_inteira, false) then
    raise exception 'Escolha um: a lista de matrículas OU a remessa inteira.' using errcode = '22023';
  end if;
  v_publico := case when v_lista is null then 'remessa_inteira' else 'lista_informada' end;

  -- Quem foi informado e NAO esta na remessa volta nominalmente, para quem
  -- registrou conferir -- contar quantos sao nao diz QUAIS sao.
  if v_lista is not null then
    select coalesce(array_agg(m order by m), '{}') into v_fora from (
      select m from unnest(v_lista) m
       except
      select t.matricula_prime
        from public.prev_titulo t
        join public.prev_titulo_lote tl on tl.titulo_id = t.id and tl.lote_id = p_lote_id
       where t.carteira_id = p_carteira_id) x;
  end if;

  insert into public.prev_acao (carteira_id, lote_id, nome, canal, contexto, filtros,
                                estado, origem, criada_por,
                                exportada_em, envio_confirmado_em)
  values (p_carteira_id, p_lote_id, btrim(p_nome), v_canal, v_ctx,
          jsonb_build_object('lote_id', p_lote_id, 'publico', v_publico,
                             'matriculas_informadas', coalesce(array_length(v_lista, 1), 0),
                             'fora_da_remessa', coalesce(array_length(v_fora, 1), 0)),
          'ENVIO_CONFIRMADO', 'EXTERNA',
          lower(coalesce(auth.jwt() ->> 'email', 'sistema')),
          p_enviada_em, p_enviada_em)
  returning id into v_acao;

  insert into public.prev_acao_destinatario (acao_id, titulo_id, matricula, aluno_nome, contato, incluido, motivo)
  select v_acao, t.id, t.matricula_prime, t.aluno_nome,
         case when v_canal = 'WHATSAPP' then t.celular_aluno else t.email_aluno end,
         true, null
    from public.prev_titulo t
    join public.prev_titulo_lote tl on tl.titulo_id = t.id and tl.lote_id = p_lote_id
   where t.carteira_id = p_carteira_id
     and (v_lista is null or t.matricula_prime = any(v_lista));

  if (select count(*) from public.prev_acao_destinatario where acao_id = v_acao) = 0 then
    raise exception 'Nenhuma das matrículas informadas está nesta remessa.' using errcode = '22023';
  end if;

  return public.preventivo_acao_resumo(v_acao) || jsonb_build_object(
    'fora_da_remessa', to_jsonb(v_fora),
    'fora_da_remessa_qtd', coalesce(array_length(v_fora, 1), 0),
    'matriculas_informadas', coalesce(array_length(v_lista, 1), 0));
end;
$$;

-- -----------------------------------------------------------------------------
-- 4B. O RESUMO DA ACAO DEVOLVE A ORIGEM
-- -----------------------------------------------------------------------------
-- Mesma funcao da migration 20261005191400, com UMA chave a mais: `origem`.
-- Sem ela a tela nao teria como marcar o que foi enviado por fora.
create or replace function public.preventivo_acao_resumo(p_acao_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare v jsonb; v_hoje date := public.preventivo_hoje();
begin
  if not public.preventivo_e_gestao() then
    raise exception 'Preventivo: acesso restrito à gestão.' using errcode = '42501';
  end if;
  select jsonb_build_object(
    'id', a.id, 'nome', a.nome, 'canal', a.canal, 'contexto', a.contexto,
    'origem', a.origem,
    'estado', a.estado, 'filtros', a.filtros,
    'criada_em', a.criada_em, 'criada_por', a.criada_por,
    'exportada_em', a.exportada_em, 'envio_confirmado_em', a.envio_confirmado_em,
    'cancelada_em', a.cancelada_em,
    'atualizacao_financeira', jsonb_build_object('sinc_id', a.sinc_referencia_id, 'em', a.sinc_referencia_em),
    'incluidos', (select count(*) from public.prev_acao_destinatario d where d.acao_id = a.id and d.incluido),
    'alunos', (select count(distinct d.matricula) from public.prev_acao_destinatario d where d.acao_id = a.id and d.incluido),
    'separados', (select coalesce(jsonb_object_agg(motivo, n), '{}'::jsonb)
                    from (select motivo, count(*) n from public.prev_acao_destinatario
                           where acao_id = a.id and not incluido and motivo is not null group by 1) s),
    'conferencia_financeira', (
      select coalesce(jsonb_object_agg(vinculo_prime, n), '{}'::jsonb)
        from (select t.vinculo_prime, count(*) n
                from public.prev_acao_destinatario d
                join public.prev_titulo t on t.id = d.titulo_id
               where d.acao_id = a.id and d.incluido group by 1) c),
    'conferencia_contexto', case when a.contexto is null then null else (
      select jsonb_build_object(
        'contexto', a.contexto,
        'titulos_incluidos', count(*),
        'divergentes', count(*) filter (
          where (a.contexto = 'PROXIMO_VENCIMENTO' and t.vencimento <  v_hoje)
             or (a.contexto = 'BOLETO_VENCIDO'     and t.vencimento >= v_hoje)),
        'rotulo_divergencia', case a.contexto
          when 'PROXIMO_VENCIMENTO' then 'títulos selecionados que JÁ venceram'
          when 'BOLETO_VENCIDO'     then 'títulos selecionados que AINDA não venceram'
        end)
        from public.prev_acao_destinatario d
        join public.prev_titulo t on t.id = d.titulo_id
       where d.acao_id = a.id and d.incluido) end
  ) into v
  from public.prev_acao a
  where a.id = p_acao_id;
  return v;
end;
$$;

-- -----------------------------------------------------------------------------
-- 4C. A CARTEIRA SO ACEITA TITULO CUJA ORIGEM ESTA NO PERIODO DELA
-- -----------------------------------------------------------------------------
-- Decisao da gestao em 06/10/2026. Um boleto com `Dt Vcto` em outubro mas
-- `Vcto Origem` em setembro (ou abril) e mensalidade de OUTRA competencia
-- reemitida -- nao e a carteira do mes. Entrava calado e misturava a
-- referencia nos indicadores.
--
-- MEDIDO nas quatro fotos de 02 a 06/10: 4, 4, 3 e 0 titulos, R$ 5.317,96 no
-- pior caso -- 0,03% dos titulos. Pequeno, mas e justamente o que explicava a
-- diferenca entre 13.972 titulos e 13.971 alunos; sem eles a relacao fica 1:1.
--
-- O PERIODO E O DA CARTEIRA, nao outubro no codigo: vale `venc_de`/`venc_ate`
-- de cada carteira, entao a regra serve para qualquer competencia.
--
-- A linha recusada NAO some: vai para `prev_lote_recusa` com o motivo
-- ORIGEM_FORA_DO_PERIODO e a linha bruta inteira, como as demais recusas.
--
-- `vencimento` (Dt Vcto) continua sendo o que rege a janela de 31 dias e o
-- casamento com o Prime. Esta regra olha so a ORIGEM, e preserva os dois
-- campos separados, como sempre.
--
-- PATCH ANCORADO sobre a definicao viva, para nao recopiar as ~90 linhas de
-- elegibilidade. Aborta se a ancora nao casar.
do $patch_origem$
declare
  v_def  text := pg_get_functiondef(
    'public.preventivo_lote_processar(uuid, jsonb, boolean, uuid)'::regprocedure);
  v_novo text;
  de text := '  alter table _prev_in add column motivo text;
  update _prev_in set motivo =
    case
      when matricula  is null then ''SEM_MATRICULA''
      when aluno_nome is null then ''SEM_NOME''
      when vencimento is null then ''VENCIMENTO_INVALIDO''
      when coalesce(valor, saldo) is null or coalesce(valor, saldo) <= 0 then ''VALOR_INVALIDO''
      when vencimento < v_carteira.venc_de or vencimento > v_carteira.venc_ate then ''FORA_DO_PERIODO''
    end
  where matricula  is null
     or aluno_nome is null
     or vencimento is null
     or coalesce(valor, saldo) is null
     or coalesce(valor, saldo) <= 0
     or vencimento < v_carteira.venc_de
     or vencimento > v_carteira.venc_ate;';
  para text := '  alter table _prev_in add column motivo text;
  update _prev_in set motivo =
    case
      when matricula  is null then ''SEM_MATRICULA''
      when aluno_nome is null then ''SEM_NOME''
      when vencimento is null then ''VENCIMENTO_INVALIDO''
      when coalesce(valor, saldo) is null or coalesce(valor, saldo) <= 0 then ''VALOR_INVALIDO''
      when vencimento < v_carteira.venc_de or vencimento > v_carteira.venc_ate then ''FORA_DO_PERIODO''
      when vencimento_origem is not null
       and (vencimento_origem < v_carteira.venc_de or vencimento_origem > v_carteira.venc_ate)
                                                                            then ''ORIGEM_FORA_DO_PERIODO''
    end
  where matricula  is null
     or aluno_nome is null
     or vencimento is null
     or coalesce(valor, saldo) is null
     or coalesce(valor, saldo) <= 0
     or vencimento < v_carteira.venc_de
     or vencimento > v_carteira.venc_ate
     or (vencimento_origem is not null
         and (vencimento_origem < v_carteira.venc_de or vencimento_origem > v_carteira.venc_ate));';
begin
  if position(de in v_def) = 0 then
    raise exception 'Preventivo: ancora do motivo nao encontrada em preventivo_lote_processar.';
  end if;
  v_novo := replace(v_def, de, para);
  if v_novo = v_def then
    raise exception 'Preventivo: o patch da origem nao alterou nada -- abortado.';
  end if;
  execute v_novo;
end
$patch_origem$;

-- -----------------------------------------------------------------------------
-- 5. A COMPARACAO PASSA A ORDENAR POR `extraido_em`
-- -----------------------------------------------------------------------------
-- Mesmas funcoes, mesma conta. So a ordem das remessas muda: a data real da
-- extracao, e nao o momento do upload.
create or replace function public.preventivo_remessa_comparar(p_lote_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare v jsonb; v_carteira uuid; v_anterior uuid; v_quando timestamptz;
begin
  if not public.preventivo_e_gestao() then
    raise exception 'Preventivo: acesso restrito à gestão.' using errcode = '42501';
  end if;
  select carteira_id, extraido_em into v_carteira, v_quando
    from public.prev_lote where id = p_lote_id;
  if v_carteira is null then
    raise exception 'Remessa não encontrada.' using errcode = '22023';
  end if;

  select id into v_anterior from public.prev_lote
   where carteira_id = v_carteira and extraido_em < v_quando and status = 'CONFIRMADO'
   order by extraido_em desc limit 1;

  if v_anterior is null then
    return jsonb_build_object('remessa', p_lote_id, 'remessa_anterior', null,
      'primeira_remessa', true,
      'observacao', 'Primeira remessa da carteira: não há anterior para comparar.');
  end if;

  select jsonb_build_object(
    'remessa', p_lote_id,
    'remessa_anterior', v_anterior,
    'primeira_remessa', false,
    'continua_em_aberto', (
      select jsonb_build_object('titulos', count(*), 'valor', coalesce(sum(ant.saldo_na_remessa), 0))
        from public.prev_titulo_lote ant
       where ant.lote_id = v_anterior
         and exists (select 1 from public.prev_titulo_lote novo
                      where novo.lote_id = p_lote_id and novo.titulo_id = ant.titulo_id)),
    'saiu_da_base', (
      select jsonb_build_object('titulos', count(*), 'valor', coalesce(sum(ant.saldo_na_remessa), 0))
        from public.prev_titulo_lote ant
       where ant.lote_id = v_anterior
         and not exists (select 1 from public.prev_titulo_lote novo
                          where novo.lote_id = p_lote_id and novo.titulo_id = ant.titulo_id)),
    'regularizados_entre_remessas', (
      select jsonb_build_object('titulos', count(*), 'valor', coalesce(sum(ant.saldo_na_remessa), 0))
        from public.prev_titulo_lote ant
       where ant.lote_id = v_anterior
         and not exists (select 1 from public.prev_titulo_lote novo
                          where novo.lote_id = p_lote_id and novo.titulo_id = ant.titulo_id)),
    'novos_na_remessa', (
      select jsonb_build_object('titulos', count(*), 'valor', coalesce(sum(novo.saldo_na_remessa), 0))
        from public.prev_titulo_lote novo
       where novo.lote_id = p_lote_id
         and not exists (select 1 from public.prev_titulo_lote ant
                          where ant.lote_id = v_anterior and ant.titulo_id = novo.titulo_id)),
    'definicao', 'SAIU DA BASE = título que estava na remessa anterior e deixou de '
              || 'aparecer no relatório seguinte. NÃO é pagamento confirmado: pode ser '
              || 'pagamento, cancelamento, renegociação, bolsa ou mudança do recorte do '
              || 'relatório. A fonte não distingue.'
  ) into v;
  return v;
end;
$$;

create or replace function public.preventivo_acao_resultado(p_acao_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v jsonb; v_lote uuid; v_carteira uuid; v_seguinte uuid;
  v_titulos int; v_saiu int; v_ancora timestamptz; v_seguinte_em timestamptz;
  v_alunos int; v_alunos_saiu int; v_valor numeric; v_valor_saiu numeric;
  v_origem text;
begin
  if not public.preventivo_e_gestao() then
    raise exception 'Preventivo: acesso restrito à gestão.' using errcode = '42501';
  end if;

  select a.lote_id, a.carteira_id, a.envio_confirmado_em, a.origem
    into v_lote, v_carteira, v_ancora, v_origem
    from public.prev_acao a where a.id = p_acao_id;
  if v_lote is null then
    return jsonb_build_object('acao', p_acao_id, 'sem_remessa', true,
      'observacao', 'Ação sem remessa vinculada: não há o que comparar.');
  end if;

  -- A regua e a primeira remessa EXTRAIDA depois do envio -- vale igual para
  -- acao do modulo e para acao externa registrada.
  if v_ancora is not null then
    select l.id, l.extraido_em into v_seguinte, v_seguinte_em
      from public.prev_lote l
     where l.carteira_id = v_carteira and l.status = 'CONFIRMADO'
       and l.extraido_em > v_ancora
     order by l.extraido_em limit 1;
  end if;

  select count(*), count(distinct d.matricula) into v_titulos, v_alunos
    from public.prev_acao_destinatario d where d.acao_id = p_acao_id and d.incluido;

  select count(*) into v_saiu
    from public.prev_acao_destinatario d
   where d.acao_id = p_acao_id and d.incluido and v_seguinte is not null
     and not exists (select 1 from public.prev_titulo_lote n
                      where n.lote_id = v_seguinte and n.titulo_id = d.titulo_id);

  select count(*) into v_alunos_saiu from (
    select d.matricula
      from public.prev_acao_destinatario d
     where d.acao_id = p_acao_id and d.incluido and v_seguinte is not null
     group by d.matricula
    having count(*) filter (where exists (
             select 1 from public.prev_titulo_lote n
              where n.lote_id = v_seguinte and n.titulo_id = d.titulo_id)) = 0
  ) x;

  select coalesce(sum(tl.saldo_na_remessa), 0) into v_valor
    from public.prev_acao_destinatario d
    join public.prev_titulo_lote tl on tl.titulo_id = d.titulo_id and tl.lote_id = v_lote
   where d.acao_id = p_acao_id and d.incluido;

  select coalesce(sum(tl.saldo_na_remessa), 0) into v_valor_saiu
    from public.prev_acao_destinatario d
    join public.prev_titulo_lote tl on tl.titulo_id = d.titulo_id and tl.lote_id = v_lote
   where d.acao_id = p_acao_id and d.incluido and v_seguinte is not null
     and not exists (select 1 from public.prev_titulo_lote n
                      where n.lote_id = v_seguinte and n.titulo_id = d.titulo_id);

  select jsonb_build_object(
    'acao', p_acao_id,
    'origem', v_origem,
    'remessa', v_lote,
    'remessa_seguinte', v_seguinte,
    'remessa_seguinte_em', v_seguinte_em,
    'comparado_a_partir_de', v_ancora,
    'aguardando_envio_confirmado', (v_ancora is null),
    'alunos_acionados', v_alunos,
    'titulos_acionados', v_titulos,
    'valor_acionado', v_valor,
    'continuam_em_aberto', case when v_seguinte is null then null else v_titulos - v_saiu end,
    'regularizados_entre_remessas', case when v_seguinte is null then null else v_saiu end,
    'saiu_da_base', case when v_seguinte is null then null else v_saiu end,
    'alunos_regularizados', case when v_seguinte is null then null else v_alunos_saiu end,
    'alunos_que_sairam', case when v_seguinte is null then null else v_alunos_saiu end,
    'valor_regularizado', case when v_seguinte is null then null else v_valor_saiu end,
    'taxa_regularizacao', case when v_seguinte is null or v_titulos = 0 then null
                               else round((v_saiu::numeric / v_titulos) * 100, 1) end,
    'taxa_regularizacao_alunos', case when v_seguinte is null or v_alunos = 0 then null
                               else round((v_alunos_saiu::numeric / v_alunos) * 100, 1) end,
    'taxa_regularizacao_valor', case when v_seguinte is null or v_valor = 0 then null
                               else round((v_valor_saiu / v_valor) * 100, 1) end,
    'aguardando_proxima_remessa', (v_ancora is not null and v_seguinte is null),
    'definicao', 'SAIU DA BASE = o título acionado não voltou na primeira remessa extraída depois do envio. NÃO é pagamento confirmado: pode ser pagamento, cancelamento, bolsa, renegociação ou mudança do recorte. O valor usa o saldo do título NA REMESSA em que ele foi acionado. Aluno que saiu = NENHUM título dele voltou.'
  ) into v;
  return v;
end;
$$;

-- -----------------------------------------------------------------------------
-- 6. EVOLUCAO DA CARTEIRA -- cards, os dois graficos e o historico
-- -----------------------------------------------------------------------------
-- CARDS POR IDENTIDADE, NAO POR SUBTRACAO. "Saiu da base" compara os TITULOS
-- da primeira foto com os da ultima, e soma o saldo que eles tinham NA
-- PRIMEIRA. Subtrair totais (13.968 - 6.278 = 7.690) erra, porque ignora as
-- entradas que apareceram no meio -- a conta certa, nas quatro fotos de
-- outubro, da 7.828 titulos.
--
-- ACOMPANHAMENTO POR ACAO: olha SO os titulos que a acao realmente incluiu, e
-- so as remessas extraidas DEPOIS do envio confirmado. Compara com a ULTIMA
-- delas, o que resolve reentrada sem contar ninguem duas vezes: titulo que
-- saiu e voltou esta presente na ultima foto, logo NAO saiu. Acao sem envio
-- confirmado nao tem resultado -- fica nula, nunca zero.
create or replace function public.preventivo_evolucao(p_carteira_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare v jsonb; v_primeiro uuid; v_ultimo uuid;
begin
  if not public.preventivo_e_gestao() then
    raise exception 'Preventivo: acesso restrito à gestão.' using errcode = '42501';
  end if;

  select id into v_primeiro from public.prev_lote
   where carteira_id = p_carteira_id and status = 'CONFIRMADO'
   order by extraido_em limit 1;
  select id into v_ultimo from public.prev_lote
   where carteira_id = p_carteira_id and status = 'CONFIRMADO'
   order by extraido_em desc limit 1;

  with remessas as (
    select l.id, l.nome, l.extraido_em,
           row_number() over (order by l.extraido_em) as ordem
      from public.prev_lote l
     where l.carteira_id = p_carteira_id and l.status = 'CONFIRMADO'
  ), foto as (
    select r.*,
           (select count(*) from public.prev_titulo_lote tl where tl.lote_id = r.id) as titulos,
           (select count(distinct t.matricula_prime)
              from public.prev_titulo_lote tl
              join public.prev_titulo t on t.id = tl.titulo_id
             where tl.lote_id = r.id) as alunos,
           (select coalesce(sum(tl.saldo_na_remessa), 0)
              from public.prev_titulo_lote tl where tl.lote_id = r.id) as saldo
      from remessas r
  ), com_anterior as (
    select f.*, lag(f.id) over (order by f.extraido_em) as anterior from foto f
  ), linhas as (
    select c.*,
           case when c.anterior is null then null else (
             select count(*) from public.prev_titulo_lote a
              where a.lote_id = c.anterior
                and not exists (select 1 from public.prev_titulo_lote b
                                 where b.lote_id = c.id and b.titulo_id = a.titulo_id)) end as saiu_titulos,
           case when c.anterior is null then null else (
             select coalesce(sum(a.saldo_na_remessa), 0) from public.prev_titulo_lote a
              where a.lote_id = c.anterior
                and not exists (select 1 from public.prev_titulo_lote b
                                 where b.lote_id = c.id and b.titulo_id = a.titulo_id)) end as saiu_valor,
           case when c.anterior is null then null else (
             select count(*) from public.prev_titulo_lote b
              where b.lote_id = c.id
                and not exists (select 1 from public.prev_titulo_lote a
                                 where a.lote_id = c.anterior and a.titulo_id = b.titulo_id)) end as entraram
      from com_anterior c
  ), acoes as (
    -- Uma linha por acao, com acompanhamento sobre o PUBLICO DELA.
    select a.id, a.nome, a.canal, a.contexto, a.origem, a.lote_id,
           a.envio_confirmado_em, a.filtros->>'publico' as publico,
           (select count(*) from public.prev_acao_destinatario d
             where d.acao_id = a.id and d.incluido) as base_titulos,
           (select count(distinct d.matricula) from public.prev_acao_destinatario d
             where d.acao_id = a.id and d.incluido) as base_alunos,
           (select coalesce(sum(tl.saldo_na_remessa), 0)
              from public.prev_acao_destinatario d
              join public.prev_titulo_lote tl on tl.titulo_id = d.titulo_id and tl.lote_id = a.lote_id
             where d.acao_id = a.id and d.incluido) as base_saldo,
           (select count(*) from public.prev_lote l
             where l.carteira_id = p_carteira_id and l.status = 'CONFIRMADO'
               and a.envio_confirmado_em is not null
               and l.extraido_em > a.envio_confirmado_em) as atualizacoes,
           (select l.id from public.prev_lote l
             where l.carteira_id = p_carteira_id and l.status = 'CONFIRMADO'
               and a.envio_confirmado_em is not null
               and l.extraido_em > a.envio_confirmado_em
             order by l.extraido_em desc limit 1) as ultima_depois
      from public.prev_acao a
     where a.carteira_id = p_carteira_id and a.cancelada_em is null
  ), acoes_m as (
    select ac.*,
           case when ac.ultima_depois is null then null else (
             select count(*) from public.prev_acao_destinatario d
              where d.acao_id = ac.id and d.incluido
                and not exists (select 1 from public.prev_titulo_lote n
                                 where n.lote_id = ac.ultima_depois and n.titulo_id = d.titulo_id)) end as saiu_titulos,
           case when ac.ultima_depois is null then null else (
             select coalesce(sum(tl.saldo_na_remessa), 0)
               from public.prev_acao_destinatario d
               join public.prev_titulo_lote tl on tl.titulo_id = d.titulo_id and tl.lote_id = ac.lote_id
              where d.acao_id = ac.id and d.incluido
                and not exists (select 1 from public.prev_titulo_lote n
                                 where n.lote_id = ac.ultima_depois and n.titulo_id = d.titulo_id)) end as saiu_valor,
           case when ac.ultima_depois is null then null else (
             select count(*) from (
               select d.matricula from public.prev_acao_destinatario d
                where d.acao_id = ac.id and d.incluido
                group by d.matricula
               having count(*) filter (where exists (
                        select 1 from public.prev_titulo_lote n
                         where n.lote_id = ac.ultima_depois and n.titulo_id = d.titulo_id)) = 0) y) end as saiu_alunos
      from acoes ac
  )
  select jsonb_build_object(
    'pontos', coalesce((select jsonb_agg(jsonb_build_object(
        'remessa', l.id, 'nome', l.nome, 'extraido_em', l.extraido_em, 'ordem', l.ordem,
        'titulos', l.titulos, 'alunos', l.alunos, 'saldo', l.saldo,
        'saiu_da_base_titulos', l.saiu_titulos, 'saiu_da_base_valor', l.saiu_valor,
        'entraram', l.entraram
      ) order by l.ordem) from linhas l), '[]'::jsonb),
    'acoes', coalesce((select jsonb_agg(jsonb_build_object(
        'id', m.id, 'nome', m.nome, 'canal', m.canal, 'contexto', m.contexto,
        'origem', m.origem, 'publico', m.publico, 'remessa', m.lote_id,
        'remessa_nome', (select l.nome from public.prev_lote l where l.id = m.lote_id),
        'enviada_em', m.envio_confirmado_em,
        'base_titulos', m.base_titulos, 'base_alunos', m.base_alunos, 'base_saldo', m.base_saldo,
        'atualizacoes_depois', m.atualizacoes,
        'comparado_com', m.ultima_depois,
        'saiu_titulos', m.saiu_titulos, 'saiu_alunos', m.saiu_alunos, 'saiu_valor', m.saiu_valor,
        'em_aberto', case when m.ultima_depois is null then null
                          else m.base_titulos - m.saiu_titulos end,
        'taxa_titulos', case when m.ultima_depois is null or m.base_titulos = 0 then null
                             else round((m.saiu_titulos::numeric / m.base_titulos) * 100, 1) end,
        'taxa_alunos', case when m.ultima_depois is null or m.base_alunos = 0 then null
                            else round((m.saiu_alunos::numeric / m.base_alunos) * 100, 1) end,
        'taxa_valor', case when m.ultima_depois is null or m.base_saldo = 0 then null
                           else round((m.saiu_valor / m.base_saldo) * 100, 1) end,
        'sem_envio_confirmado', (m.envio_confirmado_em is null)
      ) order by m.envio_confirmado_em nulls last) from acoes_m m), '[]'::jsonb),
    'cards', jsonb_build_object(
      'alunos_acionados', (
        select count(distinct d.matricula) from public.prev_acao_destinatario d
          join public.prev_acao a on a.id = d.acao_id
         where a.carteira_id = p_carteira_id and a.cancelada_em is null
           and a.envio_confirmado_em is not null and d.incluido),
      'saldo_inicial', (select coalesce(sum(saldo_na_remessa), 0)
                          from public.prev_titulo_lote where lote_id = v_primeiro),
      'titulos_inicial', (select count(*) from public.prev_titulo_lote where lote_id = v_primeiro),
      'saldo_ainda_aberto', (select coalesce(sum(saldo_na_remessa), 0)
                               from public.prev_titulo_lote where lote_id = v_ultimo),
      'titulos_ainda_abertos', (select count(*) from public.prev_titulo_lote where lote_id = v_ultimo),
      -- POR IDENTIDADE: titulo da primeira foto ausente na ultima, com o saldo
      -- que ele tinha na primeira.
      'saiu_da_base_titulos', case when v_primeiro = v_ultimo then 0 else (
        select count(*) from public.prev_titulo_lote a
         where a.lote_id = v_primeiro
           and not exists (select 1 from public.prev_titulo_lote b
                            where b.lote_id = v_ultimo and b.titulo_id = a.titulo_id)) end,
      'saiu_da_base_valor', case when v_primeiro = v_ultimo then 0 else (
        select coalesce(sum(a.saldo_na_remessa), 0) from public.prev_titulo_lote a
         where a.lote_id = v_primeiro
           and not exists (select 1 from public.prev_titulo_lote b
                            where b.lote_id = v_ultimo and b.titulo_id = a.titulo_id)) end,
      'entraram_depois', case when v_primeiro = v_ultimo then 0 else (
        select count(*) from public.prev_titulo_lote b
         where b.lote_id = v_ultimo
           and not exists (select 1 from public.prev_titulo_lote a
                            where a.lote_id = v_primeiro and a.titulo_id = b.titulo_id)) end,
      'primeira_extracao', (select extraido_em from public.prev_lote where id = v_primeiro),
      'ultima_extracao', (select extraido_em from public.prev_lote where id = v_ultimo),
      'remessas', (select count(*) from linhas)),
    'definicao', 'SAIU DA BASE = o título estava na primeira foto e não está na última. '
              || 'NÃO é pagamento confirmado. Os cards comparam TÍTULO A TÍTULO, não '
              || 'subtraem totais -- quem entrou depois não mascara quem saiu. No '
              || 'histórico, cada ação é acompanhada só sobre o público dela, contra a '
              || 'última remessa extraída após o envio: título que saiu e voltou está '
              || 'presente, logo não conta como saída.'
  ) into v;
  return v;
end;
$$;

-- -----------------------------------------------------------------------------
-- 7. PRIVILEGIOS
-- -----------------------------------------------------------------------------
revoke all on function public.preventivo_lote_confirmar_v2(uuid, text, text, jsonb, text, jsonb, timestamptz) from public, anon;
revoke all on function public.preventivo_acao_externa_registrar(uuid, uuid, text, text, text, timestamptz, text[], boolean) from public, anon;
revoke all on function public.preventivo_evolucao(uuid) from public, anon;
grant execute on function public.preventivo_lote_confirmar_v2(uuid, text, text, jsonb, text, jsonb, timestamptz) to authenticated;
grant execute on function public.preventivo_acao_externa_registrar(uuid, uuid, text, text, text, timestamptz, text[], boolean) to authenticated;
grant execute on function public.preventivo_evolucao(uuid) to authenticated;
