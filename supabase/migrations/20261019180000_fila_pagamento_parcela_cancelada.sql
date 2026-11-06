-- FILA DE EXCECOES: pagamento identificado em parcela/acordo CANCELADO (SOMENTE LEITURA).
--
-- POR QUE EXISTE: medido em 19/10/2026, 32 pagamentos de 26 alunos (R$ 88.502,95) entraram
-- no extrato Santander contra parcela que o CRM marcou CANCELADA, e em 25 deles nao existe
-- baixa equivalente. A causa comum e que o acordo foi cancelado DEPOIS de o pagamento estar
-- na base, e nada no fluxo confere isso. Ate aqui essas linhas so apareciam cruzando tabelas
-- a mao: nao havia objeto que a gestao pudesse consultar.
--
-- O QUE ESTA FUNCAO NAO FAZ: nao escreve nada. STABLE, sem INSERT/UPDATE/DELETE -- o
-- PostgreSQL recusa DML em funcao nao-volatil (0A000), entao a garantia e do motor. Nao
-- baixa, nao quita, nao cancela, nao muda status, saldo, fila ou agenda. Nao corrige nada:
-- so mostra, classificado, para decisao humana.
--
-- PORTAO: usuario_e_gestao() no corpo, porque o retorno e prova financeira por aluno e
-- inclui nome. Funcao nova herda EXECUTE para public/anon/authenticated pelo default do
-- Postgres, entao revogamos e concedemos so a authenticated (o portao interno faz o resto).
--
-- ROLLBACK (PITR nao esta habilitado, entao isso importa):
--   drop function if exists public.fila_pagamento_parcela_cancelada();
-- Nada mais a restaurar: nenhum objeto preexistente e modificado aqui.
begin;

create or replace function public.fila_pagamento_parcela_cancelada()
 returns table (
   escopo                        text,
   grupo                         text,
   classificacao                 text,
   aluno_id                      uuid,
   aluno_nome                    text,
   matricula_prime               text,
   pagamento_id                  uuid,
   data_pagamento                date,
   valor_pago                    numeric,
   boleto_pago                   text,
   parcela_id                    uuid,
   parcela_numero                int,
   parcela_valor                 numeric,
   parcela_status                text,
   acordo_id                     uuid,
   acordo_numero_ulbra           text,
   acordo_status                 text,
   acordo_mexido_em              timestamptz,
   pagou_antes_de_cancelar       boolean,
   tem_baixa_equivalente         boolean,
   baixa_sem_vinculo             boolean,
   saldo_acordo_aberto           numeric,
   substituto_na_janela          int,
   copia_ativa_mesmo_numero      int,
   parcelas_abertas_mesmo_valor  int,
   identidade_comprovada         boolean
 )
 language plpgsql
 stable
 security definer
 set search_path to 'public'
as $function$
begin
  if not public.usuario_e_gestao() then
    raise exception 'somente a gestao pode consultar a fila de pagamento em parcela cancelada'
      using errcode = '42501';
  end if;

  return query
  with boleto_unico as (
    -- Boleto duplicado NAO entra: sem unicidade nao ha vinculo deterministico, e um
    -- palpite aqui viraria "candidato" na tela. Ausencia e melhor que chute.
    select ltrim(regexp_replace(p.boleto,'[^0-9]','','g'),'0') chave,
           (min(p.id::text))::uuid parcela_id
      from public.parcelas p
     where coalesce(p.boleto,'') <> ''
     group by 1
    having count(*) = 1
  ),
  casos as (
    select g.id pagamento_id, g.aluno_id, g.data_pagamento, g.valor_pago,
           regexp_replace(coalesce(g.matricula,''),'[^0-9]','','g') matricula_prime,
           ltrim(regexp_replace(g.numero_parcela_completo,'[^0-9]','','g'),'0') boleto_pago,
           regexp_replace(coalesce(g.cpf,''),'[^0-9]','','g') cpf_pagamento,
           pc.id parcela_id, pc.numero parcela_numero, pc.valor parcela_valor, pc.status parcela_status,
           ac.id acordo_id, ac.numero_ulbra, ac.status acordo_status, ac.atualizado_em acordo_mexido_em
      from public.pagamentos g
      join boleto_unico b
        on b.chave = ltrim(regexp_replace(g.numero_parcela_completo,'[^0-9]','','g'),'0')
      join public.parcelas pc on pc.id = b.parcela_id
      join public.acordos  ac on ac.id = pc.acordo_id
     where pc.status = 'CANCELADA' or ac.status = 'CANCELADO'
  ),
  prime as (
    -- Mesma ponte de identidade da F1.b: matricula do arquivo Santander -> registration
    -- da Prime -> CPF unico -> alunos.cpf. Nome NUNCA entra na chave.
    select regexp_replace(c.registration,'[^0-9]','','g') reg,
           count(distinct regexp_replace(c.cpf,'[^0-9]','','g')) cpfs,
           min(regexp_replace(c.cpf,'[^0-9]','','g')) cpf
      from public.prime_contratos c
     group by 1
  ),
  sinais as (
    select c.*,
      al.nome aluno_nome,
      regexp_replace(coalesce(al.cpf,''),'[^0-9]','','g') cpf_aluno,
      pr.cpfs prime_cpfs, pr.cpf prime_cpf,
      exists (select 1 from public.baixas_pagamento x
               where x.aluno_id = c.aluno_id::text
                 and x.data_pagamento = c.data_pagamento
                 and abs(x.valor_pago - c.valor_pago) <= 0.01) tem_baixa_equivalente,
      exists (select 1 from public.baixas_pagamento x
               where x.aluno_id = c.aluno_id::text
                 and x.data_pagamento = c.data_pagamento
                 and abs(x.valor_pago - c.valor_pago) <= 0.01
                 and x.parcela_id is null) baixa_sem_vinculo,
      (select coalesce(round(sum(x.valor),2),0) from public.parcelas x
         join public.acordos s on s.id = x.acordo_id
        where s.aluno_id = c.aluno_id and x.status in ('A_VENCER','VENCIDA')) saldo_acordo_aberto,
      -- acordo ATIVO nascido na janela do cancelamento = substituicao deliberada
      (select count(*)::int from public.acordos s
        where s.aluno_id = c.aluno_id and s.status = 'ATIVO'
          and s.criado_em between c.acordo_mexido_em - interval '1 hour'
                              and c.acordo_mexido_em + interval '1 hour') substituto_na_janela,
      -- copia ATIVA com o MESMO numero_ulbra = duplicidade de importacao, nao substituicao
      (select count(*)::int from public.acordos s
        where s.aluno_id = c.aluno_id and s.id <> c.acordo_id and s.status = 'ATIVO'
          and c.numero_ulbra is not null
          and coalesce(s.numero_ulbra,'') = coalesce(c.numero_ulbra,'')) copia_ativa_mesmo_numero,
      -- parcela aberta hoje com EXATAMENTE o valor pago = o sinal forte de cobranca em dobro
      (select count(*)::int from public.parcelas x join public.acordos s on s.id = x.acordo_id
        where s.aluno_id = c.aluno_id and x.status in ('A_VENCER','VENCIDA')
          and abs(x.valor - c.valor_pago) <= 0.01) parcelas_abertas_mesmo_valor
    from casos c
    left join public.alunos al on al.id = c.aluno_id
    left join prime pr on pr.reg = c.matricula_prime
  )
  select
    case
      when s.parcela_status = 'CANCELADA' then 'PARCELA_CANCELADA'
      when s.parcela_status in ('A_VENCER','VENCIDA') then 'ACORDO_CANCELADO_PARCELA_ABERTA'
      else 'ACORDO_CANCELADO_PARCELA_' || s.parcela_status
    end::text,
    case when s.saldo_acordo_aberto > 0 then 'T2' else 'T1' end::text,
    -- SO_VINCULO_BAIXA vem primeiro de proposito: com baixa equivalente, ou sem nada aberto
    -- no aluno, nao existe cobranca a corrigir -- o que falta e credito/vinculo.
    case
      when s.tem_baixa_equivalente or s.saldo_acordo_aberto = 0            then 'SO_VINCULO_BAIXA'
      when s.parcelas_abertas_mesmo_valor > 0 and s.substituto_na_janela > 0 then 'COMPROVADO'
      when s.parcelas_abertas_mesmo_valor > 0                              then 'SINAL_FORTE'
      else 'INVESTIGAR'
    end::text,
    s.aluno_id, s.aluno_nome, nullif(s.matricula_prime,''),
    s.pagamento_id, s.data_pagamento, s.valor_pago, s.boleto_pago,
    s.parcela_id, s.parcela_numero, s.parcela_valor, s.parcela_status,
    s.acordo_id, s.numero_ulbra, s.acordo_status, s.acordo_mexido_em,
    (s.data_pagamento <= s.acordo_mexido_em::date),
    s.tem_baixa_equivalente, s.baixa_sem_vinculo, s.saldo_acordo_aberto,
    s.substituto_na_janela, s.copia_ativa_mesmo_numero, s.parcelas_abertas_mesmo_valor,
    -- identidade pela ponte, nunca pelo nome
    (s.matricula_prime <> '' and s.cpf_aluno ~ '^[0-9]{11}$' and s.prime_cpfs = 1
      and s.prime_cpf = s.cpf_aluno
      and (s.cpf_pagamento = '' or s.cpf_pagamento = s.cpf_aluno))
  from sinais s
  order by
    case
      when s.tem_baixa_equivalente or s.saldo_acordo_aberto = 0            then 4
      when s.parcelas_abertas_mesmo_valor > 0 and s.substituto_na_janela > 0 then 1
      when s.parcelas_abertas_mesmo_valor > 0                              then 2
      else 3
    end,
    s.valor_pago desc;
end;
$function$;

comment on function public.fila_pagamento_parcela_cancelada() is
  'Fila de excecoes SOMENTE LEITURA: pagamento do extrato identificado em parcela CANCELADA ou em acordo CANCELADO, com os sinais de risco (baixa equivalente, saldo aberto, substituto na janela do cancelamento, copia ativa com o mesmo numero_ulbra, parcela aberta com o valor exato pago) e a prova de identidade pela ponte Santander->Prime->CPF. Nao escreve, nao baixa, nao quita. Portao usuario_e_gestao().';

revoke all on function public.fila_pagamento_parcela_cancelada() from public, anon;
grant execute on function public.fila_pagamento_parcela_cancelada() to authenticated;
grant execute on function public.fila_pagamento_parcela_cancelada() to service_role;

commit;
