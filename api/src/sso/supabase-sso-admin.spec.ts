import { ATTRIBUTE_MAPPING, projectRef, serviceProviderValues } from './supabase-sso-admin';

describe('single sign-on set-up values', () => {
  it('finds the project reference in the Supabase address, unless it is given', () => {
    expect(projectRef({ SUPABASE_URL: 'https://xvpgrmujayytbbmhnoan.supabase.co' })).toBe('xvpgrmujayytbbmhnoan');
    expect(projectRef({ SUPABASE_URL: 'https://auth.example.com' })).toBeNull();
    expect(projectRef({ SUPABASE_URL: 'https://auth.example.com', SUPABASE_PROJECT_REF: 'abcdefghijklmnopqrst' })).toBe('abcdefghijklmnopqrst');
    expect(projectRef({ SUPABASE_URL: undefined })).toBeNull();
  });

  it('gives IT the service provider values for this project', () => {
    expect(serviceProviderValues('https://ref1234567890.supabase.co/')).toEqual({
      entityId: 'https://ref1234567890.supabase.co/auth/v1/sso/saml/metadata',
      acsUrl: 'https://ref1234567890.supabase.co/auth/v1/sso/saml/acs',
      metadataUrl: 'https://ref1234567890.supabase.co/auth/v1/sso/saml/metadata',
      metadataDownloadUrl: 'https://ref1234567890.supabase.co/auth/v1/sso/saml/metadata?download=true',
    });
    expect(serviceProviderValues(undefined)).toBeNull();
  });

  it('asks for names under the keys the new-user trigger reads', () => {
    expect(Object.keys(ATTRIBUTE_MAPPING.keys).sort()).toEqual(['family_name', 'given_name', 'name']);
    // Microsoft Entra sends the sign-in name (an email address) as …/claims/name, so that is never taken as the person's name.
    expect(ATTRIBUTE_MAPPING.keys.name.names).not.toContain('http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name');
  });
});
