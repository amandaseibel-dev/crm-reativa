-- CORRECAO DE UM ERRO MEU NO VIGIA.
--
-- Eu lia os digitos 2 a 8 do boleto da parcela como o numero do TITULO. Errado:
-- o boleto e 5 + numero do ACORDO com 6 digitos + parcela com 4 digitos
-- (confere em 10.916 de 10.965 = 99,6%). O documento do titulo de mensalidade e
-- outra numeracao, de outro sistema -- ZERO parcelas casam com ela.
--
-- Efeito: a checagem 'parcela_documento_de_outro_aluno' comparava o prefixo com
-- o documento de um titulo e NUNCA achava nada. Reportou 0 desde 08/09, e o 0
-- era mentira. Com a leitura certa, encontra 49 parcelas cujo boleto pertence a
-- OUTRO acordo -- R$ 89.081,49.
--
-- As checagens antigas ficam DESLIGADAS com o motivo escrito, em vez de sumir:
-- assim ninguem as ressuscita sem saber por que cairam.

insert into public.invariante_config (nome, severidade, titulo, explicacao, base_09_09)
values ('parcela_com_boleto_de_outro_acordo','GRAVE','Parcela com o boleto de outro acordo',
  'O boleto da parcela (5 + numero do acordo com 6 digitos + parcela com 4) aponta para um acordo diferente do dela. Qualquer baixa por documento cai no acordo errado.','49 · R$ 89.081,49 em 09/09'),
 ('parcela_paga_sem_assinatura_nem_pagamento','GRAVE','Baixa automatica que nenhum pagamento nomeia',
  'Parcela paga sem um pagamento que a nomeie pelo numero completo do boleto, e sem ninguem ter confirmado. Baixa confirmada por gente NAO entra aqui: vai para conferencia.','623 em 09/09')
on conflict (nome) do update
  set severidade = excluded.severidade, titulo = excluded.titulo,
      explicacao = excluded.explicacao, base_09_09 = excluded.base_09_09;

update public.invariante_config
   set ligado = false,
       explicacao = 'DESLIGADA em 09/09: nascia de uma leitura errada do boleto (digitos 2-8 como titulo, quando sao 2-7 e do acordo). Nunca poderia achar nada. Substituida por parcela_com_boleto_de_outro_acordo.'
 where nome = 'parcela_documento_de_outro_aluno';

update public.invariante_config
   set ligado = false,
       explicacao = 'DESLIGADA em 09/09: comparava uma fatia errada do boleto. Substituida por parcela_paga_sem_assinatura_nem_pagamento e baixa_sem_lastro_no_titulo.'
 where nome = 'parcela_paga_sem_pagamento';

-- Injeta os ramos novos sem reescrever os outros. ATENCAO ao apelido: o laco de
-- invariantes_rodar usa a variavel `v`, entao a tabela de vinculo vira `vin` --
-- com `v` o PL/pgSQL resolve para a variavel e o erro so aparece em execucao.
do $mig$
declare d text;
begin
  d := pg_get_functiondef('public.invariantes_rodar(text)'::regprocedure);
  if position('parcela_com_boleto_de_outro_acordo' in d) > 0 then return; end if;

  d := replace(d, '      else v_n := 0;',
$novo$      when 'parcela_com_boleto_de_outro_acordo' then
        select count(*), round(sum(p.valor),2) into v_n, v_v
          from public.parcelas p
          join public.acordos a on a.id = p.acordo_id
         where p.boleto is not null and length(p.boleto) = 11
           and a.numero_ulbra is not null
           and substring(p.boleto,2,6) <> lpad(a.numero_ulbra,6,'0');

      when 'parcela_paga_sem_assinatura_nem_pagamento' then
        select count(*), round(sum(p.valor),2) into v_n, v_v
          from public.parcelas p
         where p.status = 'PAGO'
           and p.boleto is not null and length(p.boleto) = 11
           and p.confirmado_por_email is null
           and not exists (select 1 from public.pagamentos g
                            where g.numero_parcela_completo = p.boleto);

      when 'baixa_sem_lastro_no_titulo' then
        select count(*), round(sum(p.valor),2) into v_n, v_v
          from public.parcelas p
         where p.status = 'PAGO'
           and p.boleto is not null and length(p.boleto) = 11
           and p.confirmado_por_email is null
           and not exists (select 1 from public.pagamentos g
                            where g.numero_parcela_completo is not null
                              and substring(g.numero_parcela_completo,2,6) = substring(p.boleto,2,6));

      when 'acordo_sem_pagamento_com_mensalidade_fora' then
        select count(*), round(sum(x.valor),2) into v_n, v_v from (
          select a.id, coalesce(sum(coalesce(t.valor_original,t.saldo_corrigido,0)),0) valor
            from public.acordos a
            join public.acordo_titulo_vinculo vin on vin.acordo_id = a.id and coalesce(vin.ativo,true)
            join public.acordos_titulos t on t.id = vin.titulo_id and t.status <> 'em_aberto'
           where a.status = 'ATIVO'
             and not exists (select 1 from public.parcelas p
                              where p.acordo_id = a.id and p.status = 'PAGO')
           group by a.id) x;

      when 'parcela_re_acordada_ainda_cobrando' then
        select count(*), round(sum(p.valor),2) into v_n, v_v
          from public.parcelas p
          join public.acordos_titulos t on t.documento = '0' || p.boleto
          join public.acordos nv on nv.id = t.acordo_id
         where p.boleto is not null and p.status in ('VENCIDA','A_VENCER')
           and nv.status in ('ATIVO','QUITADO');

      when 'mensalidade_presa_em_acordo_cancelado' then
        select count(*), round(sum(coalesce(t.valor_original,t.saldo_corrigido,0)),2) into v_n, v_v
          from public.acordo_titulo_vinculo vin
          join public.acordos a on a.id = vin.acordo_id
                               and upper(coalesce(a.status,'')) in ('CANCELADO','CANCELADA')
          join public.acordos_titulos t on t.id = vin.titulo_id
         where t.status = 'vinculada' and upper(coalesce(t.situacao,'')) = 'NEGOCIADO';

      else v_n := 0;$novo$);

  if position('parcela_com_boleto_de_outro_acordo' in d) = 0 then
    raise exception 'MIGRATION ABORTADA: nao achei o ponto de insercao.';
  end if;
  execute d;
end $mig$;
