# Fluxo de desenvolvimento e releases

Este projeto possui dois aplicativos Windows instaláveis lado a lado:

| Canal | Nome visível | Identificador | Atualização automática | Envio ao EDV |
| --- | --- | --- | --- | --- |
| Oficial | DMH Kontakte und Kalender | `de.dmh.agendakontakte` | Última release oficial | Ativo |
| Admin Test | DMH Kontakte und Kalender Admin Test | `de.dmh.agendakontakte.admin-test` | Release fixa `admin-test` | Desativado |

Os dois canais usam pastas de dados, banco SQLite, WebView e namespace de credenciais diferentes. A versão Admin Test também exibe uma faixa vermelha permanente. Assim, ela pode ser instalada no mesmo computador sem modificar a instalação oficial.

O Admin Test gera somente o instalador NSIS (`setup.exe`), pois ele aceita versões
pré-release como `0.1.1-beta.1` e é compatível com o updater. A release oficial
continua gerando MSI e NSIS.

## Configuração inicial no GitHub

1. Manter a branch `main` como fonte das releases oficiais.
2. Opcionalmente, criar o branch `staging` quando a equipe quiser um fluxo separado de desenvolvimento e enviá-lo ao GitHub:

   ```powershell
   git switch -c staging
   git push -u origin staging
   git switch main
   ```

3. Em **Settings > Environments**, criar:
   - `admin-test`, sem aprovação obrigatória;
   - `production`, com o administrador como *required reviewer* e sem autoaprovação, se o plano do repositório disponibilizar essa proteção.
4. Confirmar em **Settings > Secrets and variables > Actions**:
   - em **Variables**: `M365_CLIENT_ID` e `M365_TENANT_ID`;
   - em **Secrets**: `TAURI_SIGNING_PRIVATE_KEY`;
   - em **Secrets**, somente se a chave foi criada com senha:
     `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, contendo exatamente a senha original;
   - em **Secrets**: `MIGRATION_CAPTURE_URL`.
5. Verificar se **Actions > General > Workflow permissions** permite escrita do `GITHUB_TOKEN`, necessária para publicar releases.

O ambiente `production` funciona como o último portão humano. Se a conta/plano não disponibilizar revisores obrigatórios para este repositório, o workflow continua sendo manual e executa todas as verificações antes de publicar diretamente o commit selecionado da `main`.

## Release oficial diretamente da main

1. Implementar e testar a alteração, fazer commit na `main` e enviá-la ao GitHub.
2. Aguardar o workflow `CI`, que valida frontend, formatação e testes Rust.
3. Confirmar que a versão-base existente no código está consistente:

   ```powershell
   npm run version:check
   ```

4. Em **Actions > Offizielle Windows-Version veröffentlichen > Run workflow**, selecionar `main` e informar a próxima versão oficial, por exemplo `0.1.1`.
5. Aprovar o ambiente `production`. O workflow só libera a versão se:
    - a versão informada for aplicada e conferida automaticamente em todos os manifestos e lockfiles do build;
    - testes e build passarem;
    - o endpoint EDV e a assinatura de produção estiverem configurados.
6. Depois da publicação, as instalações oficiais encontram a nova release pelo atualizador automático.

## Admin Test opcional

Para alterações que mereçam um ciclo isolado, o canal Admin Test continua disponível, mas não é pré-requisito para a release oficial:

1. Em **Actions > Admin-Test-Version veröffentlichen > Run workflow**, selecionar `main`.
2. Usar `source_ref: main` e uma versão como `0.1.1-beta.1`.
3. Instalar ou atualizar o Admin Test, validar com uma cópia dos dados e repetir com `beta.2`, `beta.3` etc. quando necessário.
4. Quando o mesmo commit estiver aprovado, executar a release oficial diretamente da `main`.

Não crie manualmente commits ou tags do tipo `Release vX.Y.Z`. O workflow oficial cria a tag e a release. A versão final é aplicada apenas no ambiente temporário de build, mantendo os manifestos e lockfiles da `main` consistentes.

Se um deploy falhar, abra o resumo da execução em **Actions**. Os workflows de Admin Test e release oficial escrevem uma tabela de resultados no *Step summary* e disponibilizam um artefato `*-diagnostics-...` por 30 dias. O relatório contém somente referências, versões e resultados dos passos; valores de secrets e tokens nunca são incluídos.

Antes de substituir o Admin Test anterior, o workflow constrói e assina integralmente o novo instalador. Assim, uma falha de código, configuração ou empacotamento não remove a última versão de teste funcional.

## Teste local isolado

Para abrir o aplicativo de desenvolvimento no canal Admin Test:

```powershell
npm run tauri:dev:admin-test
```

Para gerar um instalador Admin Test local:

```powershell
npm run tauri:build:admin-test
```

Esses comandos usam outro diretório de dados e deixam o endpoint EDV de produção desativado. O desenvolvimento oficial comum continua disponível com `npm run tauri:dev`.

## Copiar dados reais sem tocar na instalação oficial

1. Na instalação oficial, abrir **Einstellungen > Sicherung**.
2. Criar uma Sicherung JSON e armazená-la temporariamente em local seguro.
3. Abrir o Admin Test e restaurar esse arquivo no mesmo menu.
4. Apagar a cópia quando ela não for mais necessária.

A Sicherung inclui contatos, grupos, calendário e preferências permitidas. Ela exclui senhas, referências secretas e o status de transmissão ao EDV. Uma restauração também não apaga nem reativa o status EDV já existente no aplicativo de destino.

## Convenção de versões

- Oficial: `0.1.0`, `0.1.1`, `0.2.0`.
- Admin Test: `0.1.1-beta.1`, `0.1.1-beta.2`, `0.1.1-rc.1`.

A versão-base fica consistente no código. Tanto o sufixo beta do Admin Test quanto o número final escolhido para a release oficial são aplicados no servidor temporário de build; portanto, publicar uma versão não cria commits descartáveis nem deixa manifestos e lockfiles divergentes.

## Primeira publicação 0.1.0

1. Rodar `npm run version:check` e confirmar que todos os arquivos mostram a mesma versão-base.
2. Confirmar que a CI da `main` passou.
3. Opcionalmente, publicar e validar `0.1.0-beta.1` no canal Admin Test.
4. Executar a release oficial `0.1.0` diretamente da `main` e aprovar `production`.
5. Instalar a release oficial em um PC piloto antes de distribuí-la às usuárias.

## Rollback

Não substitua silenciosamente uma release oficial já distribuída. Se houver defeito em `0.1.1`, corrija em `staging`, teste como `0.1.2-beta.1` e publique `0.1.2`. Guarde os instaladores antigos para recuperação manual, mas prefira sempre avançar com uma versão de correção.
