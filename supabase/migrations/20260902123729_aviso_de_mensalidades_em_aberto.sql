-- Arte nova: "Aviso de mensalidades em aberto".
--
-- Amanda, 02/09: mandou o texto pronto e pediu para encaixar no layout ja
-- definido, com um assunto que "de gatilho para abrir".
--
-- ASSUNTO. "Aviso importante sobre o seu contrato com a ULBRA" -- o "Aviso
-- importante" e o gatilho, o "seu contrato com a ULBRA" da legitimidade. De
-- proposito NAO cita divida: a previa da caixa de entrada aparece na tela do
-- celular na frente de terceiros, e expor a inadimplencia ali e o que o art. 42
-- do CDC nao perdoa.
--
-- OCUPA O LUGAR (ordem 2) da arte de rematricula ocultada em
-- 20260902170000_arte_de_rematricula_sai_da_ficha.sql. E a nova primeira
-- abordagem: texto institucional, sem valor e sem prazo, para o aluno que ainda
-- nao foi acionado. O `sugerir()` da ficha passa a apontar para ela.
--
-- Layout identico as demais: cabecalho com a logo, corpo com borda, caixa azul
-- no chamado para contato, botoes de WhatsApp/telefone e rodape cinza.
-- A assinatura e institucional ("Equipe ReATIVA -- Atendimento ULBRA"), como
-- Amanda escreveu -- as outras artes assinam com {{operador}}.
--
-- Escrito junto com a aplicacao em prod (02/09). `email_templates` so existe em
-- prod hoje, dai a guarda de tabela.

do $$
begin
  if to_regclass('public.email_templates') is null then
    return;
  end if;

  insert into public.email_templates
    (chave, situacao, ordem, assunto, corpo_html, corpo_texto, permite_anexo, ativo, dias_retorno, novo)
  values (
    'aviso_mensalidades_aberto',
    'Aviso de mensalidades em aberto',
    2,
    'Aviso importante sobre o seu contrato com a ULBRA',
    '<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#0f172a"><div style="background:#ffffff;padding:22px 20px;border:1px solid #e5e7eb;border-bottom:none;border-radius:12px 12px 0 0;text-align:center"><img src="https://crm-reativa.vercel.app/logo_padrao_email.png" alt="ReATIVA" width="200" style="display:inline-block;width:200px;max-width:200px;height:auto;border:0;outline:none;text-decoration:none"></div><div style="border:1px solid #e5e7eb;border-top:none;border-radius:0 0 12px 12px;padding:20px;line-height:1.5"><p>Olá, <strong>{{nome}}</strong>!</p><p>Identificamos mensalidades em aberto vinculadas ao seu contrato junto à ULBRA.</p><p style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:10px">Entre em contato com nossa equipe para consultar os valores em aberto e conhecer as opções disponíveis para regularização.</p><p>Estamos à disposição para esclarecer eventuais dúvidas e orientar sobre as condições disponíveis para negociação.</p><p style="color:#64748b;font-size:13px">Caso o pagamento já tenha sido realizado, por favor, desconsidere esta mensagem.</p><div style="margin-top:18px;padding-top:14px;border-top:1px solid #eef2f6"><a href="https://wa.me/5551992741192" style="display:inline-block;background:#25D366;color:#fff;text-decoration:none;padding:9px 14px;border-radius:8px;font-weight:700">💬 WhatsApp (51) 99274-1192</a> <a href="tel:+555134779218" style="display:inline-block;margin-left:8px;background:#1e40af;color:#fff;text-decoration:none;padding:9px 14px;border-radius:8px;font-weight:700">📞 Ligações (51) 3477-9218</a></div><p style="color:#64748b;font-size:13px;margin-top:14px">Atenciosamente,<br><strong>Equipe ReATIVA</strong> — Atendimento ULBRA</p></div></div>',
    'Olá, {{nome}}!

Identificamos mensalidades em aberto vinculadas ao seu contrato junto à ULBRA.

Entre em contato com nossa equipe para consultar os valores em aberto e conhecer as opções disponíveis para regularização.

Estamos à disposição para esclarecer eventuais dúvidas e orientar sobre as condições disponíveis para negociação.

Fale com a gente no WhatsApp (51) 99274-1192 (abrir: https://wa.me/5551992741192) ou Ligações (51) 3477-9218.

Caso o pagamento já tenha sido realizado, por favor, desconsidere esta mensagem.

Atenciosamente,
Equipe ReATIVA — Atendimento ULBRA',
    false,
    true,
    2,
    true
  )
  on conflict (chave) do update set
    situacao      = excluded.situacao,
    ordem         = excluded.ordem,
    assunto       = excluded.assunto,
    corpo_html    = excluded.corpo_html,
    corpo_texto   = excluded.corpo_texto,
    permite_anexo = excluded.permite_anexo,
    ativo         = excluded.ativo,
    dias_retorno  = excluded.dias_retorno,
    novo          = excluded.novo;
end $$;
