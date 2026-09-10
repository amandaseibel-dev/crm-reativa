-- FILA DE ACORDOS SEM RESPONSAVEL: filtrar pelo campo certo e permitir vincular
-- (10/09/2026)
--
-- A fila subiu hoje de manha com o filtro errado. Ela se chama "acordos sem
-- responsavel", mas filtrava pelo dono do CASO:
--
--     where c.id is null or c.operador_email is null
--
-- Depois do giro praticamente todo caso tem dono, entao a fila mostrava 12 de
-- ~930. O campo que interessa e outro -- acordos.operador_responsavel_email --
-- e ele esta vazio em 889 acordos ATIVOS, R$ 1.226.570,97 em aberto. O maior
-- deles e um acordo de R$ 236.929,17 (Giovanna do Valle Oliveira) que nunca
-- apareceu na tela porque a ficha dela tem dona (Olga). Dono da ficha e
-- responsavel pelo acordo sao coisas separadas; a fila confundia as duas.
--
-- Tres correcoes:
--
--   1. fila_acordos_sem_responsavel  -- filtra por acordos.operador_responsavel_email
--      is null e saldo em aberto > 0. Nao olha mais o dono do caso; ele vira
--      apenas informacao, para a gestao saber a quem o aluno ja pertence.
--
--   2. A identidade deixa de depender do caso. Quando nao ha caso mas ha aluno,
--      o nome e o aluno_id vem de `alunos` -- sem isso a linha aparecia como
--      "sem ficha" e o botao nao abria nada, porque o aluno_id vinha nulo.
--      Os 17 casos assim tem TODOS aluno cadastrado: o que falta e o caso.
--
--   3. vincular_responsavel_acordo -- grava o responsavel NO ACORDO, em lote.
--      A funcao anterior (atribuir_acordo_sem_responsavel) gravava em
--      casos.operador_email, ou seja, trocava o dono da ficha, e recusava
--      quando o caso ja tinha dono -- exatamente os 918. Ela nunca foi usada
--      (zero registros de ACORDO_SEM_RESPONSAVEL_ATRIBUIDO) e fica desativada.
--
-- NAO aplicada em producao por este arquivo: a sessao estava em somente
-- leitura. Aplicar pelo painel ou pelo CLI depois de revisar.

-- ---------------------------------------------------------------------------
-- 1. A fila
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.fila_acordos_sem_responsavel();

CREATE OR REPLACE FUNCTION public.fila_acordos_sem_responsavel()
 RETURNS TABLE(
   acordo_id uuid, situacao text, cpf text, aluno text,
   caso_id uuid, aluno_id uuid,
   valor_total numeric, saldo_aberto numeric,
   parcelas_abertas integer, parcelas_vencidas integer, dias_atraso integer,
   dono_caso_email text, dono_caso_nome text,
   criado_em timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with ac as (
    select a.id, a.cpf, a.valor_total, a.criado_em,
           count(*) filter (where pp.ab)::int                                              abertas,
           count(*) filter (where pp.ab and pp.vencimento < current_date)::int              vencidas,
           max(current_date - pp.vencimento) filter (where pp.ab and pp.vencimento < current_date)::int dias,
           round(sum(pp.valor) filter (where pp.ab), 2)                                     saldo
      from public.acordos a
      join lateral (
        select pp.*, upper(coalesce(pp.status,'')) not in
               ('PAGO','PAGA','CANCELADA','CANCELADO','ESTORNADA','ESTORNADO') ab
          from public.parcelas pp where pp.acordo_id = a.id) pp on true
     -- O FILTRO. E so isto que define a fila.
     where a.status = 'ATIVO'
       and a.operador_responsavel_email is null
     group by a.id, a.cpf, a.valor_total, a.criado_em
  )
  select ac.id,
         -- A situacao descreve o CADASTRO, nao a titularidade: toda linha aqui
         -- ja e, por definicao, um acordo sem responsavel.
         case when c.id is not null then 'COM_CASO'
              when al.id is not null then 'SEM_CASO'
              else 'SEM_FICHA' end,
         ac.cpf,
         coalesce(c.nome, c.nome_aluno, al.nome),
         c.id,
         -- Fallback para `alunos`: sem ele a ficha nao abre nos que nao tem caso.
         coalesce(c.aluno_id, al.id),
         ac.valor_total, ac.saldo, ac.abertas, ac.vencidas, ac.dias,
         c.operador_email, c.operador_nome,
         ac.criado_em
    from ac
    -- LATERAL com limit 1, nao join simples: ha CPF repetido em `casos` (fichas
    -- duplicadas), e um join comum multiplicaria o acordo em varias linhas.
    left join lateral (
      select c.* from public.casos c
       where lpad(regexp_replace(coalesce(c.cpf_limpo,''), '\D','','g'), 11, '0') = ac.cpf
       order by (c.operador_email is not null) desc, c.created_at desc nulls last
       limit 1) c on true
    left join lateral (
      select al.* from public.alunos al
       where lpad(regexp_replace(coalesce(al.cpf,''), '\D','','g'), 11, '0') = ac.cpf
       order by al.created_at desc nulls last
       limit 1) al on true
   -- Saldo zerado ou negativo nao e fila de ninguem: sao 9 acordos, um deles
   -- com -R$ 3,98 de credito.
   where coalesce(ac.saldo, 0) > 0
   order by ac.saldo desc nulls last;
$function$;

COMMENT ON FUNCTION public.fila_acordos_sem_responsavel() IS
  'Acordos ATIVOS com operador_responsavel_email vazio e saldo em aberto. O dono do caso vem junto apenas como informacao — ele NAO faz parte do filtro (era o bug de 10/09/2026, que escondia 918 acordos).';

GRANT EXECUTE ON FUNCTION public.fila_acordos_sem_responsavel() TO authenticated;

-- ---------------------------------------------------------------------------
-- 2. Vincular o responsavel AO ACORDO, em lote
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.vincular_responsavel_acordo(
  p_acordo_ids uuid[],
  p_email text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_quem  text := lower(coalesce(auth.email(), ''));
  v_nome  text;
  v_qtd   int;
begin
  -- Mesma regra que a gestao definiu em 10/09/2026 para a base nova e para a
  -- troca de operador na Projecao: so a Amanda e a Fernanda.
  if v_quem not in ('amanda.seibel@aelbra.com.br', 'cobranca04@aelbra.com.br') then
    raise exception 'Só a Amanda e a Fernanda podem vincular o responsável de um acordo.'
      using errcode = '42501';
  end if;

  if p_acordo_ids is null or array_length(p_acordo_ids, 1) is null then
    raise exception 'Nenhum acordo selecionado.';
  end if;

  select nome into v_nome from public.usuarios where email = lower(p_email) and ativo;
  if v_nome is null then
    raise exception 'Operador % não encontrado ou inativo.', p_email;
  end if;

  -- So preenche o que esta vazio. Se outra pessoa vinculou entre a leitura da
  -- tela e o clique, o valor dela permanece -- vincular nao e sobrescrever.
  update public.acordos a
     set operador_responsavel_email = lower(p_email),
         operador_responsavel_nome  = v_nome,
         atualizado_em              = now()
   where a.id = any(p_acordo_ids)
     and a.status = 'ATIVO'
     and a.operador_responsavel_email is null;
  get diagnostics v_qtd = row_count;

  insert into public.aluno_movimentacoes
    (aluno_id, tipo, descricao, registrado_por_email, registrado_em,
     operador_novo_email, operador_novo_nome)
  select coalesce(c.aluno_id, al.id)::text,
         'ATRIBUICAO_ACORDO',
         'Responsável do acordo vinculado pela fila de acordos sem responsável.',
         v_quem, now(), lower(p_email), v_nome
    from public.acordos a
    left join lateral (
      select c.aluno_id from public.casos c
       where lpad(regexp_replace(coalesce(c.cpf_limpo,''), '\D','','g'), 11, '0') = a.cpf
         and c.aluno_id is not null
       limit 1) c on true
    left join lateral (
      select al.id from public.alunos al
       where lpad(regexp_replace(coalesce(al.cpf,''), '\D','','g'), 11, '0') = a.cpf
       limit 1) al on true
   where a.id = any(p_acordo_ids)
     and a.operador_responsavel_email = lower(p_email)
     and coalesce(c.aluno_id, al.id) is not null;

  return jsonb_build_object(
    'vinculados', v_qtd,
    'operador_email', lower(p_email),
    'operador_nome', v_nome);
end;
$function$;

COMMENT ON FUNCTION public.vincular_responsavel_acordo(uuid[], text) IS
  'Define o responsável de acordos ATIVOS que estao sem ele. Mexe SO em acordos — nao toca no dono do caso nem na carteira. Restrita a Amanda e Fernanda.';

REVOKE ALL ON FUNCTION public.vincular_responsavel_acordo(uuid[], text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.vincular_responsavel_acordo(uuid[], text) TO authenticated;

-- ---------------------------------------------------------------------------
-- 3. A funcao antiga sai de cena
-- ---------------------------------------------------------------------------
-- Gravava em casos.operador_email (trocava o dono da FICHA) e recusava quando o
-- caso ja tinha dono. Nunca foi usada: zero registros de
-- ACORDO_SEM_RESPONSAVEL_ATRIBUIDO em historico_operadores_alunos.
DROP FUNCTION IF EXISTS public.atribuir_acordo_sem_responsavel(uuid, text);
