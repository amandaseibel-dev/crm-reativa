-- PREVENTIVO: o custo da acao passa a dizer EM QUE MOEDA.
--
-- O campo nasceu como numero puro e a tela escrevia "R$" por conta propria.
-- O envio de WhatsApp de 05/10 foi pago em DOLAR -- ou seja, a tela estava
-- afirmando um fato falso sobre dinheiro. Nao e detalhe de formatacao: custo
-- em USD lido como BRL vira comparacao errada com o saldo da carteira.
--
-- AS REGRAS, e por que cada uma:
--
--   BRL ou USD, e nada alem disso. Lista fechada por constraint: moeda e
--   dominio, nao texto livre.
--
--   MOEDA NULA E "NAO INFORMADA", nao "real". As acoes que ja tinham custo
--   gravado NAO ganham moeda por presuncao -- ninguem perguntou a elas. A tela
--   diz "moeda nao informada" em vez de inventar o simbolo.
--
--   NADA DE CONVERSAO. Nao ha cotacao aqui, nem deve haver: o total consolidado
--   sai SEPARADO POR MOEDA. Somar BRL com USD seria o mesmo erro, so que
--   escondido num numero so.
--
--   NENHUM CALCULO DA CARTEIRA MUDA. Custo nunca entrou em saldo, reducao ou
--   percentual, e continua fora.

-- -----------------------------------------------------------------------------
-- 1. A COLUNA
-- -----------------------------------------------------------------------------
alter table public.prev_acao add column if not exists custo_moeda text;

alter table public.prev_acao drop constraint if exists prev_acao_custo_moeda_conhecida;
alter table public.prev_acao add constraint prev_acao_custo_moeda_conhecida
  check (custo_moeda is null or custo_moeda in ('BRL', 'USD'));

-- Moeda sem valor nao quer dizer nada.
alter table public.prev_acao drop constraint if exists prev_acao_custo_moeda_exige_valor;
alter table public.prev_acao add constraint prev_acao_custo_moeda_exige_valor
  check (custo_moeda is null or custo_total is not null);

comment on column public.prev_acao.custo_moeda is
  'Moeda do custo: BRL ou USD. NULL = nao informada -- a tela NAO presume real. '
  'Nao ha conversao cambial em lugar nenhum: totais saem separados por moeda.';

-- -----------------------------------------------------------------------------
-- 2. A FUNCAO QUE GRAVA
-- -----------------------------------------------------------------------------
-- p_moeda NULL nao limpa a moeda: PRESERVA a que estiver la. Limpar e trabalho
-- de p_custo NULL, que zera valor e moeda juntos -- se nao ha valor, moeda nao
-- quer dizer nada. Esse detalhe tambem protege a janela entre aplicar a
-- migration e subir o deploy: a tela antiga chama com dois argumentos, cai
-- nesta mesma funcao pelo DEFAULT e NAO apaga a moeda de ninguem.
-- A versao de dois argumentos SAI: mantida, ela e a de tres com DEFAULT ficariam
-- ambiguas e toda chamada falharia com "is not unique". A tela antiga continua
-- funcionando porque chama por argumentos NOMEADOS (p_acao_id, p_custo) e cai
-- nesta, com p_moeda no default.
drop function if exists public.preventivo_acao_custo_definir(uuid, numeric);

create or replace function public.preventivo_acao_custo_definir(
  p_acao_id uuid, p_custo numeric, p_moeda text default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare v_carteira uuid; v_moeda text;
begin
  if not public.preventivo_e_gestao() then
    raise exception 'Preventivo: acesso restrito à gestão.' using errcode = '42501';
  end if;
  if p_custo is not null and p_custo < 0 then
    raise exception 'O custo não pode ser negativo.' using errcode = '22023';
  end if;
  if p_moeda is not null and p_moeda not in ('BRL', 'USD') then
    raise exception 'Moeda inválida: use BRL ou USD.' using errcode = '22023';
  end if;

  select carteira_id, custo_moeda into v_carteira, v_moeda
    from public.prev_acao where id = p_acao_id;
  if v_carteira is null then
    raise exception 'Ação não encontrada.' using errcode = '22023';
  end if;

  update public.prev_acao
     set custo_total = p_custo,
         custo_moeda = case when p_custo is null then null
                            else coalesce(p_moeda, v_moeda) end
   where id = p_acao_id;

  select custo_moeda into v_moeda from public.prev_acao where id = p_acao_id;

  return jsonb_build_object('acao', p_acao_id, 'custo_total', p_custo,
                            'custo_moeda', v_moeda,
                            'informado', (p_custo is not null));
end;
$$;

comment on function public.preventivo_acao_custo_definir(uuid, numeric, text) is
  'Define ou limpa o custo total de uma acao e sua moeda (BRL ou USD). Custo NULL volta '
  'tudo para nao informado; moeda NULL preserva a que ja estava. Negativo e recusado.';

revoke all on function public.preventivo_acao_custo_definir(uuid, numeric, text) from public, anon;
grant execute on function public.preventivo_acao_custo_definir(uuid, numeric, text) to authenticated;

-- -----------------------------------------------------------------------------
-- 3. AS DUAS LEITURAS, por patch ancorado
-- -----------------------------------------------------------------------------
-- Patch, e nao reescrita: as duas funcoes sao grandes e so precisam carregar um
-- campo a mais. Cada bloco aborta se a ancora nao estiver la ou aparecer duas
-- vezes, e e idempotente pelo texto NOVO.
do $$
declare
  v_def text := pg_get_functiondef('public.preventivo_painel(uuid)'::regprocedure);
  v_novo text;
  -- a) a CTE `acoes` precisa trazer a coluna
  a_de   text := 'a.envio_confirmado_em, a.envio_precisao, a.custo_total,';
  a_para text := 'a.envio_confirmado_em, a.envio_precisao, a.custo_total, a.custo_moeda,';
  -- b) o objeto `custo` de cada acao precisa devolver a moeda
  b_de   text := '''informado'', (k.custo_total is not null),';
  b_para text := '''informado'', (k.custo_total is not null),' || E'\n' ||
                 '          ''moeda'', k.custo_moeda,';
  -- c) o total consolidado passa a sair SEPARADO POR MOEDA
  c_de   text := '''custo_total'', (select case when count(*) filter (where custo_total is not null) = 0 then null
                                  else coalesce(sum(custo_total),0) end from acoes),';
  c_para text := '''custos_por_moeda'', (select jsonb_agg(jsonb_build_object(''moeda'', m, ''total'', t) order by m)
         from (select coalesce(custo_moeda, ''NAO_INFORMADA'') as m, sum(custo_total) as t
                 from acoes where custo_total is not null group by 1) z),';
  conta int;
begin
  if position(a_para in v_def) > 0 then
    return;  -- ja aplicado
  end if;

  foreach v_novo in array array[a_de, b_de, c_de] loop
    conta := (length(v_def) - length(replace(v_def, v_novo, ''))) / length(v_novo);
    if conta <> 1 then
      raise exception 'preventivo_painel: ancora ausente ou repetida (% ocorrencias): %',
        conta, left(v_novo, 60);
    end if;
  end loop;

  v_novo := replace(replace(replace(v_def, a_de, a_para), b_de, b_para), c_de, c_para);
  if v_novo = v_def then
    raise exception 'preventivo_painel: a substituicao nao alterou o corpo.';
  end if;
  execute v_novo;
end $$;

do $$
declare
  v_def text := pg_get_functiondef('public.preventivo_intervalos(uuid)'::regprocedure);
  v_de  text := '''custo_informado'', (a.custo_total is not null), ''custo_total'', a.custo_total)';
  v_para text := '''custo_informado'', (a.custo_total is not null), ''custo_total'', a.custo_total, '
              || '''custo_moeda'', a.custo_moeda)';
  v_novo text;
begin
  if position(v_para in v_def) > 0 then
    return;
  end if;
  if (length(v_def) - length(replace(v_def, v_de, ''))) / length(v_de) <> 1 then
    raise exception 'preventivo_intervalos: ancora ausente ou repetida.';
  end if;
  v_novo := replace(v_def, v_de, v_para);
  if v_novo = v_def then
    raise exception 'preventivo_intervalos: a substituicao nao alterou o corpo.';
  end if;
  execute v_novo;
end $$;
