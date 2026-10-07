-- Indicador "Casos ainda pendentes" na Efetividade.
--
-- REGRA, definida pela gestao em 07/10/2026: e pendente o caso que
--   (a) NAO tem nenhum pagamento registrado   OU
--   (b) tem acordo ATIVO com parcela ainda a receber
-- Uniao das duas, sem contar o mesmo caso duas vezes.
--
-- CHAVE: aluno_id. NUNCA casos.cpf_limpo -- ele esta vazio em parte da base e
-- os vazios colapsariam em um grupo so, inventando resultado.
--
-- ESCOPO: casos NAO encerrados operacionalmente. Caso encerrado saiu da
-- operacao e chama-lo de "ainda pendente" seria afirmar trabalho que ninguem
-- vai fazer. Medido em 07/10/2026: dos 83 casos sem aluno_id, ZERO estao
-- ativos, entao nao ha caso entrando por vacuidade do `not exists`; e nenhum
-- aluno tem mais de um caso ativo, entao caso e aluno sao 1:1 aqui e nao ha
-- contagem dupla por esse lado.
--
-- PAGAMENTO = existir linha em public.pagamentos para aquele aluno_id. A tabela
-- nao tem coluna de estorno, entao nao ha o que descontar; qualquer linha conta
-- como pagamento registrado.
--
-- ACORDO ABERTO = acordos.status = 'ATIVO' com ao menos uma parcela cujo status
-- nao e PAGO nem CANCELADA. ACORDO QUITADO NAO ENTRA, por construcao: o filtro
-- e status = 'ATIVO', e QUITADO e CANCELADO ficam de fora.
--   RENEGOCIADA foi medida a parte e NAO muda o resultado: com ou sem ela na
--   exclusao o numero e o mesmo (2.117 casos), porque parcela RENEGOCIADA nunca
--   e a unica parcela viva de um acordo ATIVO. Ficou fora da lista de exclusao
--   para seguir docs/REGRA-SALDO-COBRAVEL.md, que so exclui PAGO e CANCELADA.
--
-- OS CASOS QUE A REGRA COBRE, conferidos um a um:
--   sem pagamento e sem acordo ....... entra, pelo ramo (a)
--   pagamento parcial + acordo aberto  entra, pelo ramo (b)
--   sem pagamento + acordo aberto .... entra UMA vez (e a sobreposicao)
--   acordo quitado e com pagamento ... NAO entra
--
-- MEDIDO em 07/10/2026, escopo nao encerrados (12.859 casos):
--   sem pagamento .... 11.494
--   acordo aberto ....  2.117
--   sobreposicao .....    972
--   TOTAL UNICO ...... 12.639   (11.494 + 2.117 - 972)
--
-- Custo: 670 ms como `authenticated` com o teto de 8s. Nao precisa de snapshot.
--
-- NAO TOCA as seis linhas financeiras nem nenhum calculo existente: a funcao e
-- nova, STABLE, e so le.

create or replace function public.casos_pendentes_contar()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare v_out jsonb;
begin
  if not public.carteira_2026_1_pode_ler() then
    raise exception 'Acesso negado.' using errcode = '42501';
  end if;

  with base as (
    select c.id, c.aluno_id
      from public.casos c
     where not coalesce(c.encerrado_operacional, false)
  ),
  sem_pagamento as (
    select b.id from base b
     where not exists (select 1 from public.pagamentos p where p.aluno_id = b.aluno_id)
  ),
  com_acordo_aberto as (
    select distinct b.id from base b
      join public.acordos a on a.aluno_id = b.aluno_id and a.status = 'ATIVO'
     where exists (
       select 1 from public.parcelas p
        where p.acordo_id = a.id
          and upper(coalesce(p.status,'')) not in ('PAGO','CANCELADA'))
  )
  select jsonb_build_object(
    'gerado_em', now(),
    'escopo', 'casos nao encerrados operacionalmente',
    'casos_no_escopo',   (select count(*) from base),
    'sem_pagamento',     (select count(*) from sem_pagamento),
    'com_acordo_aberto', (select count(*) from com_acordo_aberto),
    'nos_dois',          (select count(*) from sem_pagamento s join com_acordo_aberto x using (id)),
    'pendentes',         (select count(*) from (select id from sem_pagamento
                                                union
                                                select id from com_acordo_aberto) u)
  ) into v_out;

  return v_out;
end;
$function$;

revoke all on function public.casos_pendentes_contar() from public, anon;
grant execute on function public.casos_pendentes_contar() to authenticated, service_role;
